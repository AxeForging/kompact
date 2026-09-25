/**
 * The recorder writes a file the developer never asked for.
 *
 * That is the whole risk of this feature, so the first test drives a planted
 * credential all the way through the real `register` — both hooks, then the
 * flush — and asserts it is absent from the store and from the file. Testing
 * `redact` alone would not catch a recorder that forgot to call it, which is
 * exactly the mistake worth catching.
 *
 * The fake engine mirrors two behaviours of the real one that a looser stub
 * would hide: `store.set` round-trips through JSON, as the documented store
 * does, and `clock.now` returns a number rather than a Date.
 */
import { describe, expect, it } from 'vitest';

import { SIGNALS_FILE, STORE_KEY, asAggregate, prune, register } from '../hooks/laya-signals.js';

/** Assembled, not written out: see the note in `test/signals.test.ts`. */
const FAKE = {
  github: `ghp_${'A'.repeat(36)}`,
  urlPassword: 's3cr3tpass',
};

type Handler = (dollar: unknown, event: unknown, next: (event: unknown) => unknown) => Promise<unknown>;

// `types/claude-code.d.ts` is an ambient declaration file rather than a module,
// so `On` and `PluginOptions` are read off `register` instead of imported.
type On = Parameters<typeof register>[0];
type PluginOptions = Parameters<typeof register>[1];

function harness(options: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>();
  const files = new Map<string, string>();
  let clock = 1_700_000_000_000;

  const engine = {
    store: {
      get: async (key: string) => store.get(key),
      // The real store hands back `JSON.parse(JSON.stringify(value))`, so a test
      // must not be able to pass on a Map or a Date the engine would flatten.
      set: async (key: string, value: unknown) => {
        store.set(key, JSON.parse(JSON.stringify(value)) as unknown);
      },
    },
    clock: { now: async () => (clock += 1000) },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/tester' : undefined) },
    fs: { write: async (path: string, text: string) => void files.set(path, text) },
  };

  const handlers = new Map<string, Handler>();
  const on = ((name: string, handler: Handler) => void handlers.set(name, handler)) as unknown as On;
  register(on, options as PluginOptions);

  const fire = async (name: string, event: Record<string, unknown>): Promise<void> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`nothing registered on ${name}`);
    await handler(engine, event, (e) => e);
  };

  return {
    fire,
    handlers,
    rows: () => asAggregate(store.get(STORE_KEY)),
    /** Everything that reached the store, as one string to search. */
    stored: () => JSON.stringify([...store.entries()]),
    written: () => files.get(`/home/tester/${SIGNALS_FILE}`) ?? '',
  };
}

function batch(calls: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PostToolBatch',
    session_id: 's1',
    transcript_path: '/dev/null',
    cwd: '/tmp',
    tool_calls: calls.map((call, index) => ({ tool_use_id: `u${index}`, ...call })),
    ...extra,
  };
}

function bash(command: string, response: unknown = 'ok') {
  return { tool_name: 'Bash', tool_input: { command }, tool_response: response };
}

function prompt(text: string, source = 'user') {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 's1',
    transcript_path: '/dev/null',
    cwd: '/tmp',
    source,
    prompt: text,
  };
}

describe('a planted credential never reaches disk', () => {
  it('is absent from both the store and the flushed file', async () => {
    const h = harness();
    await h.fire('classic.PostToolBatch', batch([
      bash(`gh api -H "Authorization: Bearer ${FAKE.github}"`),
      bash(`psql postgres://admin:${FAKE.urlPassword}@db.example.test/app`),
    ]));
    await h.fire('classic.UserPromptSubmit', prompt(`deploy with ${FAKE.github} please`));
    await h.fire('turn.complete', { hook_event_name: 'TurnComplete' });

    // The file must exist, or the assertions below pass on nothing at all.
    expect(h.written().length, 'nothing was flushed').toBeGreaterThan(2);
    for (const secret of [FAKE.github, FAKE.urlPassword]) {
      expect(h.stored(), 'the secret reached the store').not.toContain(secret);
      expect(h.written(), 'the secret reached the file').not.toContain(secret);
    }
  });
});

describe('counting', () => {
  it('collapses the same command run against different files', async () => {
    const h = harness();
    await h.fire('classic.PostToolBatch', batch([bash('npm test -- test/a.spec.ts')]));
    await h.fire('classic.PostToolBatch', batch([bash('npm test -- test/b.spec.ts')]));
    const commands = Object.values(h.rows()).filter((row) => row.kind === 'command');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.n).toBe(2);
    expect(commands[0]?.samples).toHaveLength(2);
  });

  it('records a retry loop when a failed command later succeeds', async () => {
    const h = harness();
    await h.fire('classic.PostToolBatch', batch([bash('npm run build', { is_error: true })]));
    await h.fire('classic.PostToolBatch', batch([bash('npm run build')]));
    const fixes = Object.values(h.rows()).filter((row) => row.kind === 'error-fix');
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.n).toBe(1);
  });

  it('marks the first batch of a session as rebuilding context', async () => {
    const h = harness();
    await h.fire('classic.PostToolBatch', batch([
      bash('git log --oneline -5'),
      { tool_name: 'Read', tool_input: {}, tool_response: 'x' },
    ]));
    await h.fire('classic.PostToolBatch', batch([bash('npm test')]));
    const orient = Object.values(h.rows()).filter((row) => row.kind === 'orient');
    expect(orient, 'only the first batch orients').toHaveLength(1);
    expect(orient[0]?.n).toBe(1);
  });

  it('separates a correction from an ordinary request', async () => {
    const h = harness();
    // Before any work, "no, ..." is a request rather than a correction.
    await h.fire('classic.UserPromptSubmit', prompt('no, use rtk instead of grep'));
    await h.fire('classic.PostToolBatch', batch([bash('grep -rn thing src')]));
    await h.fire('classic.UserPromptSubmit', prompt('no, use rtk instead of grep'));
    const kinds = Object.values(h.rows()).map((row) => row.kind);
    expect(kinds).toContain('correction');
    expect(kinds).toContain('intent');
  });
});

describe('what it refuses to record', () => {
  it('ignores the calls a subagent made', async () => {
    const h = harness();
    await h.fire('classic.PostToolBatch', batch([bash('npm test')], { agent_id: 'a1' }));
    expect(Object.keys(h.rows())).toHaveLength(0);
  });

  it('ignores a prompt the machine wrote', async () => {
    const h = harness();
    await h.fire('classic.UserPromptSubmit', prompt('a task notification arrived', 'system'));
    expect(Object.keys(h.rows())).toHaveLength(0);
  });

  it('registers nothing at all when recording is switched off', () => {
    const h = harness({ recordSignals: false });
    expect(h.handlers.size).toBe(0);
  });
});

describe('the store stays inside its cap', () => {
  it('keeps the most-repeated rows and forgets the rest', () => {
    const rows = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        `command::c${i}`,
        { kind: 'command' as const, n: i, calls: 1, chars: 0, sessions: [], samples: [], lastSeen: i },
      ]),
    );
    const kept = prune(rows, 10);
    expect(Object.keys(kept)).toHaveLength(10);
    expect(kept['command::c49'], 'the most repeated row was dropped').toBeDefined();
    expect(kept['command::c0'], 'a row seen once survived the cap').toBeUndefined();
  });

  it('starts over on a corrupt stored value rather than throwing', () => {
    expect(asAggregate('not an object')).toEqual({});
    expect(asAggregate({ 'command::x': { kind: 'command' } })).toEqual({});
  });
});
