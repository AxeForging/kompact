import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  askerFor, compactSession, decisionLogLines, layaAsker, readLocalWeights, register, resolveHookConfig, summarize, toSessionMessages,
} from '../hooks/laya-compact.js';
import { FeatureAsker, parseWeights } from '../src/features.js';
import type { CompactResult, Message } from '../src/index.js';

/** The fixture is structurally what the engine passes; it carries no handles. */
const asSession = (messages: Message[]) => messages as never;

const never: () => never = () => {
  throw new Error('the features scorer must not touch the network');
};

function transcript(): Message[] {
  const pair = (id: string, tool: string, input: Record<string, unknown>, out: string): Message[] => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: out, isError: false }] },
  ];
  return [
    { role: 'user', text: 'fix the test', toolUses: [] },
    ...pair('c1', 'Read', { file_path: 'a.ts' }, 'x'.repeat(5000)),
    ...pair('c2', 'Edit', { file_path: 'a.ts' }, 'updated'),
    ...pair('c3', 'Bash', { command: 'ls' }, 'a.ts\nb.ts\n'.repeat(200)),
    { role: 'assistant', text: 'done', toolUses: [] },
    { role: 'user', text: 'ok', toolUses: [] },
  ];
}

describe('resolveHookConfig', () => {
  it('defaults to the built-in scorer and needs no key', () => {
    const config = resolveHookConfig({});
    expect(config.scorer).toBe('features');
    expect(config.compactAtPercent).toBe(60);
    expect(config.minReductionRatio).toBe(0.25);
  });

  it('opts in to laya only when asked by name', () => {
    expect(resolveHookConfig({ scorer: 'laya' }).scorer).toBe('laya');
    expect(resolveHookConfig({ scorer: 'nonsense' }).scorer).toBe('features');
  });

  it('passes numeric options through and ignores rubbish', () => {
    const config = resolveHookConfig({ keepThreshold: 0.8, preserveRecentMessages: 'no' });
    expect(config.keepThreshold).toBe(0.8);
    expect(config.preserveRecentMessages).toBeUndefined();
  });

  // Every option the manifest offers has to reach `compact`. Two did not:
  // `targetReduction` — the main dial — was missing from the numeric list, and
  // `phrasing` had no handling at all, so the wording comparison it exists for
  // could not be run from the plugin.
  it('carries every option the manifest offers', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as { userConfig: Record<string, { type: string; default?: unknown }> };
    const sample: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(manifest.userConfig)) {
      sample[key] = spec.type === 'number' ? 0.42 : spec.default;
    }
    const config = resolveHookConfig(sample as never) as unknown as Record<string, unknown>;
    for (const key of Object.keys(manifest.userConfig)) {
      expect(config[key], `${key} is offered in plugin.json but never read`).toBeDefined();
    }
  });

  it('accepts the three phrasings and nothing else', () => {
    expect(resolveHookConfig({ phrasing: 'direct' }).phrasing).toBe('direct');
    expect(resolveHookConfig({ phrasing: 'entailment' }).phrasing).toBe('entailment');
    expect(resolveHookConfig({ phrasing: 'shouty' }).phrasing).toBeUndefined();
  });
});

describe('askerFor', () => {
  it('returns the offline scorer by default', () => {
    expect(askerFor(resolveHookConfig({}), never)).toBeInstanceOf(FeatureAsker);
  });

  it('returns an HTTP asker when laya is selected', () => {
    expect(askerFor(resolveHookConfig({ scorer: 'laya' }), never)).not.toBeInstanceOf(FeatureAsker);
  });

  it('sends laya requests to the configured sidecar', async () => {
    let seen = '';
    const asker = layaAsker(async (url) => {
      seen = url;
      return { status: 200, ok: true, text: '{"answers":{}}' };
    }, 'http://127.0.0.1:9999/v1/systemone');
    await asker.ask('state', {});
    expect(seen).toBe('http://127.0.0.1:9999/v1/systemone');
  });
});

describe('compactSession', () => {
  it('compacts with no network access at all', async () => {
    const messages = transcript();
    const { result, messages: out } = await compactSession(asSession(messages), resolveHookConfig({}), never);
    expect(result.stats.failedRequests).toBe(0);
    expect(out.length).toBeLessThanOrEqual(messages.length);
  });

  it('hands back the engine’s own objects for untouched messages', async () => {
    const messages = transcript();
    const { messages: out } = await compactSession(asSession(messages), resolveHookConfig({ keepThreshold: 0 }), never);
    expect(out[0]).toBe(messages[0]);
  });
});

describe('toSessionMessages', () => {
  it('rebuilds only what changed', () => {
    const messages = transcript();
    const changed: Message[] = [messages[0]!, { role: 'assistant', text: 'new', toolUses: [] }];
    const out = toSessionMessages(asSession(messages), changed);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).not.toBe(messages[1]);
  });
});

describe('summarize', () => {
  const stats = (extra: Partial<CompactResult['stats']>): CompactResult => ({
    messages: [], decisions: [],
    stats: {
      messagesBefore: 10, messagesAfter: 8, charsBefore: 1000, charsAfter: 500,
      calls: 3, kept: 1, resultsDropped: 1, callsDropped: 1, pinned: 0,
      maxRowTokens: 700, truncatedRequests: 0, checkpoint: '', requests: 3, failedRequests: 0, ms: 12,
      ...extra,
    },
  });

  /**
   * The page prints this notice under "How you know it is running" and tells the
   * reader that seeing something else means the hook never ran. It quoted a
   * string invented from memory — neither "freed" nor "floor" appears in any
   * notice — so a correctly-working install would have looked broken. The drift
   * guard binds the page to eval/RESULTS.md and nothing bound it to hooks/.
   */
  it('emits the exact line the page tells readers to look for', () => {
    // Bind the whole line, not fragments: summarize() puts its semicolon after
    // whichever part comes last, so asserting "calls dropped;" broke the moment
    // the example gained a `pinned` part it needed to balance.
    const line = summarize(stats({
      charsBefore: 1000, charsAfter: 770,
      kept: 34, resultsDropped: 1, callsDropped: 2, pinned: 4, requests: 41, ms: 4,
    }), 'features');
    // The page wraps inside the <code>, so compare on collapsed whitespace.
    const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'index.html'), 'utf8')
      .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    expect(page, `docs/index.html does not quote the line summarize() emits:\n  ${line}`)
      .toContain(line);
    for (const invented of ['0.2 floor', '% freed,']) {
      expect(line).not.toContain(invented);
      expect(page, `docs/index.html quotes "${invented}", which no notice emits`).not.toContain(invented);
    }
  });

  it('shouts about silent truncation, which nothing else would reveal', () => {
    expect(summarize(stats({ truncatedRequests: 4 }), 'laya')).toContain('4 STATES TRUNCATED');
    expect(summarize(stats({}), 'features')).not.toContain('TRUNCATED');
  });

  it('names the scorer actually used', () => {
    expect(summarize(stats({}), 'features')).toContain('via features');
    expect(summarize(stats({ checkpoint: 'multilingual' }), 'laya')).toContain('via laya/multilingual');
  });

  it('reports scoring failures, because those silently keep content', () => {
    expect(summarize(stats({ failedRequests: 2 }), 'features')).toContain('2 scoring failures (kept)');
  });
});

describe('decisionLogLines', () => {
  it('says so when there is nothing to report', () => {
    expect(decisionLogLines({ decisions: [], stats: {} } as unknown as CompactResult)).toEqual(['decisions: (none)']);
  });

  it('splits a long log into numbered chunks', () => {
    const decisions = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`, tool: 'Read', action: 'keep' as const, reason: 'kept' as const, keepCall: 0.5, keepResult: 0.5,
    }));
    const lines = decisionLogLines({ decisions } as unknown as CompactResult, 300);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^decisions \(1\/\d+\)/);
  });
});

/** A stand-in for the engine, enough to drive `register` end to end. */
function fakeEngine(percent = 10, fetch = async (): Promise<never> => {
  throw new Error('sidecar unreachable');
}) {
  const logs: string[] = [];
  const toasts: string[] = [];
  let compactRequested = 0;
  const $ = {
    ui: { log: (t: string) => logs.push(t), toast: (t: string) => toasts.push(t) },
    http: { fetch },
    clock: { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) },
    session: {
      usage: async () => ({ context: { percent } }),
      compact: async () => { compactRequested += 1; },
    },
  };
  return { $, logs, toasts, get compactRequested() { return compactRequested; } };
}

function registered(options: Record<string, unknown> = {}) {
  const handlers = new Map<string, Function>();
  const on = (event: string, handler: Function) => handlers.set(event, handler);
  register(on as never, options as never);
  return handlers;
}

describe('register', () => {
  it('registers both hooks', () => {
    const handlers = registered();
    expect([...handlers.keys()].sort()).toEqual(['session.compact', 'turn.complete']);
  });

  it('replaces the history instead of summarising when it saves enough', async () => {
    const handlers = registered({ preserveRecentMessages: 2, keepThreshold: 0.9 });
    const engine = fakeEngine();
    const event = { messages: asSession(transcript()) };
    const result = await handlers.get('session.compact')!(engine.$, event, () => 'FELL_BACK');
    expect(result).not.toBe('FELL_BACK');
    expect(result.messages.length).toBeGreaterThan(0);
    expect(engine.toasts.join(' ')).toContain('no summary');
  });

  it('falls back to the built-in summary when it saves too little', async () => {
    const handlers = registered({ preserveRecentMessages: 2, minReductionRatio: 0.99 });
    const engine = fakeEngine();
    const result = await handlers.get('session.compact')!(
      engine.$, { messages: asSession(transcript()) }, () => 'FELL_BACK');
    expect(result).toBe('FELL_BACK');
    expect(engine.toasts.join(' ')).toContain('fallback to built-in summary');
  });

  // The one that matters most: a broken sidecar must never break a session.
  it('falls back when the laya sidecar is unreachable', async () => {
    const handlers = registered({ scorer: 'laya', preserveRecentMessages: 2 });
    const engine = fakeEngine();
    const result = await handlers.get('session.compact')!(
      engine.$, { messages: asSession(transcript()) }, () => 'FELL_BACK');
    expect(result).toBe('FELL_BACK');
    expect(engine.toasts.join(' ')).toContain('sidecar unreachable');
  });

  // A sidecar that accepts the connection and then stalls is the failure the
  // rejecting-fetch test above cannot reach: without a deadline the hook never
  // returns at all, and the session appears frozen rather than degraded.
  it('falls back when the laya sidecar accepts the request and then hangs', async () => {
    const handlers = registered({
      scorer: 'laya', preserveRecentMessages: 2, requestTimeoutMs: 20,
    });
    const engine = fakeEngine(10, () => new Promise<never>(() => {}));
    const result = await handlers.get('session.compact')!(
      engine.$, { messages: asSession(transcript()) }, () => 'FELL_BACK');
    expect(result).toBe('FELL_BACK');
    expect(engine.toasts.join(' ')).toContain('did not respond within 20ms');
  });

  it('requests compaction only once the context passes the threshold', async () => {
    const below = fakeEngine(10);
    await registered({ compactAtPercent: 60 }).get('turn.complete')!(below.$, {}, () => 'NEXT');
    expect(below.compactRequested).toBe(0);

    const above = fakeEngine(80);
    await registered({ compactAtPercent: 60 }).get('turn.complete')!(above.$, {}, () => 'NEXT');
    expect(above.compactRequested).toBe(1);
  });

  it('never lets a usage-lookup failure break the turn', async () => {
    const engine = fakeEngine();
    engine.$.session.usage = async () => { throw new Error('no usage'); };
    const result = await registered().get('turn.complete')!(engine.$, {}, () => 'NEXT');
    expect(result).toBe('NEXT');
    expect(engine.logs.join(' ')).toContain('auto-compact skipped');
  });
});

describe('locally calibrated weights', () => {
  const valid = JSON.stringify({
    keepResult: new Array(13).fill(0.1),
    keepCall: new Array(13).fill(0.2),
    fittedOn: '500 calls, 9 sessions, 2026-01-01',
  });

  it('parses a well-formed weights value', () => {
    const weights = parseWeights(valid);
    expect(weights.keepResult).toHaveLength(13);
    expect(weights.fittedOn).toContain('9 sessions');
  });

  it('refuses the wrong shape rather than half-applying it', () => {
    expect(() => parseWeights('{}')).toThrow();
    expect(() => parseWeights(JSON.stringify({ keepResult: [1, 2], keepCall: [1, 2] }))).toThrow();
    expect(() => parseWeights(JSON.stringify({
      keepResult: new Array(13).fill(0), keepCall: new Array(13).fill(Number.NaN),
    }))).toThrow();
  });

  it('prefers the environment, then settings', async () => {
    const logs: string[] = [];
    const fromEnv = await readLocalWeights(
      { env: { get: async () => valid }, settings: { read: async () => ({}) } },
      (t) => logs.push(t),
    );
    expect(fromEnv?.keepResult[0]).toBe(0.1);
    const fromSettings = await readLocalWeights(
      { env: { get: async () => undefined }, settings: { read: async () => ({ env: { LAYA_COMPACT_WEIGHTS: valid } }) } },
      (t) => logs.push(t),
    );
    expect(fromSettings?.keepResult[0]).toBe(0.1);
    expect(logs.join(' ')).toContain('9 sessions');
  });

  // A bad value must cost the operator nothing but a log line.
  it('ignores a malformed value and says so', async () => {
    const logs: string[] = [];
    const weights = await readLocalWeights(
      { env: { get: async () => 'not json' }, settings: { read: async () => ({}) } },
      (t) => logs.push(t),
    );
    expect(weights).toBeUndefined();
    expect(logs.join(' ')).toContain('ignoring LAYA_COMPACT_WEIGHTS');
  });

  it('survives a host that offers neither channel', async () => {
    // An engine that offers neither channel: both lookups throw, neither is fatal.
    expect(await readLocalWeights({} as never, () => {})).toBeUndefined();
  });

  it('actually changes the scores it returns', async () => {
    const flat = { keepResult: new Array(13).fill(0), keepCall: new Array(13).fill(0) };
    const asker = FeatureAsker.fromWeights(flat);
    const { answers } = await asker.ask('The assistant ran the Read tool on the file a.ts.', {
      result_t1: { type: 'noul', instructions: 'x' },
    });
    // All-zero weights mean every state scores exactly one half.
    expect((answers.result_t1 as { noul: number }).noul).toBeCloseTo(0.5, 6);
  });
});
