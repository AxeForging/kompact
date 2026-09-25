/**
 * Noticing what the developer repeats, while they work.
 *
 * The plugin already reads every tool call to decide what to keep at a
 * compaction. The same observation answers a different question — what does
 * this person do over and over? — and that answer is a skill waiting to be
 * written, which nobody writes because noticing the repetition is the hard
 * part.
 *
 * Two hooks, both doing the same small thing: turn what just happened into a
 * signature (`src/signals.ts`) and increment a counter. `eval/propose.ts` reads
 * the result and ranks it; nothing here decides anything.
 *
 * Three constraints shaped the design, and all three were worth having:
 *
 *   1. **The store is capped at 4 MiB** and has no append. That forbids keeping
 *      a raw log and forces aggregation in place — which is also the only shape
 *      that stays readable after a year of sessions.
 *   2. **`classic.PostToolBatch` fires once per batch, after every call in it
 *      has resolved.** `classic.PostToolUse` fires per tool and may run
 *      concurrently for parallel calls, so a read-modify-write on one store key
 *      would silently lose signals. This event is also off the critical path:
 *      it runs before the next model request, not before the tool.
 *   3. **Everything is redacted before it is stored**, on one path, so there is
 *      one place to audit. The recorder test plants a credential through this
 *      module and asserts it reaches neither the store nor the file.
 *
 * Recording is local and never leaves the machine. Set `recordSignals` to false
 * in the plugin's settings to turn it off entirely.
 */
import type { On, PluginOptions, Register } from 'claude-code';

import {
  type SignalKind,
  commandSignature,
  intentSignature,
  isCorrection,
  isSequenceWorthKeeping,
  redact,
  sequenceSignature,
} from '../src/signals.js';

/** One counted shape. Totals, not a log — see the 4 MiB cap above. */
export type Row = {
  kind: SignalKind;
  /** Times this shape was seen. */
  n: number;
  /** Tool calls it stood for in total; the proposer divides by `n`. */
  calls: number;
  /** Characters of tool output it moved in total. */
  chars: number;
  /** Distinct sessions it appeared in — a habit, rather than one bad afternoon. */
  sessions: string[];
  /** Up to three redacted instances, so a reader can see what was grouped. */
  samples: string[];
  /** Epoch milliseconds. A number, because `$.clock.now()` is what a hook has. */
  lastSeen: number;
};

export type Aggregate = Record<string, Row>;

export const STORE_KEY = 'signals';
export const SIGNALS_FILE = '.claude/laya-signals.json';

const MAX_ROWS = 2000;
const MAX_SAMPLES = 3;
const MAX_SESSIONS = 50;
const SAMPLE_CHARS = 200;

/** `kind` is part of the key: the same command is a different row as a retry. */
function rowKey(kind: SignalKind, sig: string): string {
  return `${kind}::${sig}`;
}

/** Whatever the store hands back, as an aggregate. A corrupt value starts over. */
export function asAggregate(stored: unknown): Aggregate {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const rows: Aggregate = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Partial<Row>;
    if (typeof row.kind !== 'string' || typeof row.n !== 'number') continue;
    rows[key] = {
      kind: row.kind as SignalKind,
      n: row.n,
      calls: typeof row.calls === 'number' ? row.calls : 0,
      chars: typeof row.chars === 'number' ? row.chars : 0,
      sessions: Array.isArray(row.sessions) ? row.sessions.filter((s) => typeof s === 'string') : [],
      samples: Array.isArray(row.samples) ? row.samples.filter((s) => typeof s === 'string') : [],
      lastSeen: typeof row.lastSeen === 'number' ? row.lastSeen : 0,
    };
  }
  return rows;
}

/**
 * Counts one observation.
 *
 * `sample` goes through `redact` here rather than at the call sites, so adding a
 * seventh detector cannot forget to do it.
 */
export function bump(
  rows: Aggregate,
  kind: SignalKind,
  sig: string,
  sample: string,
  session: string,
  calls: number,
  chars: number,
  at: number,
): void {
  if (!sig) return;
  const key = rowKey(kind, sig);
  const row = rows[key] ?? { kind, n: 0, calls: 0, chars: 0, sessions: [], samples: [], lastSeen: at };
  row.n += 1;
  row.calls += calls;
  row.chars += chars;
  row.lastSeen = at;
  if (session && !row.sessions.includes(session) && row.sessions.length < MAX_SESSIONS) {
    row.sessions.push(session);
  }
  const short = redact(sample).slice(0, SAMPLE_CHARS).trim();
  if (short && row.samples.length < MAX_SAMPLES && !row.samples.includes(short)) {
    row.samples.push(short);
  }
  rows[key] = row;
}

/**
 * Bounds the store, without letting one kind eat it.
 *
 * ponytail: keep the most-repeated rows of each kind and forget the rest — a
 * shape seen once is exactly what this feature has no use for.
 *
 * The round-robin is not decoration. Pruning by count alone, measured on 40 real
 * sessions, filled all 2,000 rows with commands and sequences and cut `orient`
 * from five shapes to one: the kinds that are rare by nature — a correction, the
 * way a session starts — are precisely the ones a global sort starves, and they
 * are the most valuable rows here. So each kind is sorted by its own counts and
 * they take turns.
 */
export function prune(rows: Aggregate, max: number = MAX_ROWS): Aggregate {
  const keys = Object.keys(rows);
  if (keys.length <= max) return rows;
  const byKind = new Map<SignalKind, string[]>();
  for (const key of keys) {
    const kind = (rows[key] as Row).kind;
    byKind.set(kind, [...(byKind.get(kind) ?? []), key]);
  }
  for (const group of byKind.values()) {
    group.sort((a, b) => {
      const left = rows[a] as Row;
      const right = rows[b] as Row;
      return right.n - left.n || right.lastSeen - left.lastSeen;
    });
  }
  const queues = [...byKind.values()];
  const kept: Aggregate = {};
  let taken = 0;
  while (taken < max && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const key = queue.shift();
      if (key === undefined) continue;
      kept[key] = rows[key] as Row;
      if (++taken >= max) break;
    }
  }
  return kept;
}

/** The command a Bash call ran, if this is one. */
export function bashCommand(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : '';
}

/**
 * Whether a resolved call failed.
 *
 * `tool_response` is `unknown` in the hook types and carries no documented error
 * field, so this reads the two shapes Claude Code actually produces: the
 * `is_error` flag on a tool result, and a response that opens with an error.
 * ponytail: a miss costs one error→fix row, never a wrong decision — widen it
 * only if that kind comes back empty on real sessions.
 */
export function failed(response: unknown): boolean {
  if (response && typeof response === 'object') {
    const flags = response as { is_error?: unknown; isError?: unknown };
    if (flags.is_error === true || flags.isError === true) return true;
  }
  if (typeof response !== 'string') return false;
  return response.startsWith('Error') || response.startsWith('<tool_use_error>');
}

/** How much output a call moved, for the time estimate. */
export function responseChars(response: unknown): number {
  if (typeof response === 'string') return response.length;
  if (response === undefined || response === null) return 0;
  try {
    return JSON.stringify(response).length;
  } catch {
    return 0;
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  if (options['recordSignals'] === false) return;

  // Session-lived and deliberately not stored: what the next event needs to
  // know about the last one. A hot reload resets it, which costs at most the
  // first batch of one session.
  let batches = 0;
  let lastSequence = '';
  /** The last three tool steps, across batches. See the note at the 3-gram below. */
  const recent: Array<{ tool: string; command?: string }> = [];
  const awaitingFix = new Set<string>();
  let unflushed = false;

  on('classic.PostToolBatch', async ($, event, next) => {
    try {
      // A subagent's calls are the agent's work, not the developer's habit.
      if (event.agent_id) return next(event);
      const at = await $.clock.now();
      const rows = asAggregate(await $.store.get(STORE_KEY));
      const session = event.session_id;
      const steps: Array<{ tool: string; command?: string }> = [];

      for (const call of event.tool_calls) {
        const command = bashCommand(call.tool_input);
        steps.push(command ? { tool: call.tool_name, command } : { tool: call.tool_name });
        if (!command) continue;
        const sig = commandSignature(command);
        bump(rows, 'command', sig, command, session, 1, responseChars(call.tool_response), at);
        // A failure and a later success on the same shape is a retry loop: the
        // thing worth a skill is whatever had to be got right the second time.
        if (failed(call.tool_response)) awaitingFix.add(sig);
        else if (awaitingFix.delete(sig)) {
          bump(rows, 'error-fix', sig, command, session, 2, 0, at);
        }
      }

      const sequence = sequenceSignature(steps);
      // A run of tools has to be counted across batches, not inside one. Measured
      // on 2,145 calls of real sessions, a batch is almost always a single call,
      // so keying on the batch produced exactly zero sequences — the thing this
      // kind exists to find. Three consecutive steps, sliding.
      recent.push(...steps);
      while (recent.length > 3) recent.shift();
      if (recent.length === 3 && isSequenceWorthKeeping(recent)) {
        bump(rows, 'sequence', sequenceSignature(recent), '', session, 3, 0, at);
      }
      // The first batch of a session is context being rebuilt from nothing,
      // which is the largest repeated cost in agentic work.
      if (batches === 0 && steps.length > 0) bump(rows, 'orient', sequence, '', session, steps.length, 0, at);
      batches += 1;
      lastSequence = sequence;

      await $.store.set(STORE_KEY, prune(rows));
      unflushed = true;
    } catch {
      // Recording is a side-effect of the session, never a risk to it.
    }
    return next(event);
  });

  on('classic.UserPromptSubmit', async ($, event, next) => {
    try {
      // `system`, `loop_wakeup` and the rest are the machine talking to itself.
      if ((event.source && event.source !== 'user') || event.agent_id) return next(event);
      const at = await $.clock.now();
      const rows = asAggregate(await $.store.get(STORE_KEY));
      // A correction only reads as one when it follows work: "no, not like
      // that" opening a session is a request, not a correction. Each one is a
      // standing preference the assistant keeps missing, so it earns a line in
      // CLAUDE.md rather than a skill — which is why it is its own kind.
      const kind: SignalKind = batches > 0 && isCorrection(event.prompt) ? 'correction' : 'intent';
      bump(rows, kind, intentSignature(event.prompt), event.prompt, event.session_id, 0, 0, at);
      await $.store.set(STORE_KEY, prune(rows));
      unflushed = true;
    } catch {
      // As above.
    }
    return next(event);
  });

  on('turn.complete', async ($, event, next) => {
    try {
      if (!unflushed) return next(event);
      const at = await $.clock.now();
      const rows = asAggregate(await $.store.get(STORE_KEY));
      // Whatever ran last before handing back is the verification ritual, and
      // it is only knowable as last once the turn is over.
      if (lastSequence) {
        bump(rows, 'verify', lastSequence, '', '', 0, 0, at);
        await $.store.set(STORE_KEY, prune(rows));
        lastSequence = '';
      }
      // The store is the plugin's own file in a shape only the engine reads, so
      // the CLI gets a copy it can open. Written as `$.env.get('HOME')` with the
      // name spelled out: the plugin validator lists the variables a module
      // reads and cannot follow an identifier or an optional chain.
      const home = await $.env.get('HOME');
      if (home) {
        await $.fs.write(
          `${home}/${SIGNALS_FILE}`,
          JSON.stringify({ version: 1, writtenAt: at, rows }),
        );
        unflushed = false;
      }
    } catch {
      // A failed flush leaves `unflushed` set, so the next turn retries.
    }
    return next(event);
  });
};
