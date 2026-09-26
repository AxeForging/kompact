import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { registerSignals } from './kompact-signals.js';
import { compact, reductionRatio } from '../src/compact.js';
import { FeatureAsker, WEIGHTS_ENV, parseWeights, type Weights } from '../src/features.js';
import type {
  CompactOptions,
  CompactResult,
  Asker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minFreedPercent: 5,
  maxPasses: 6,
};

/** Where the per-transcript pass count lives, beside the recorder's own key. */
export const PASSES_KEY = 'passes';
/** Records kept in the store. Enough for a week of transcripts; ~80 bytes each. */
const PASSES_KEPT = 32;
/** Turns `turn.complete` waits after a pass, so `usage()` is not read stale. */
const COOLDOWN_TURNS = 2;

export type HookConfig = CompactOptions & {
  compactAtPercent: number;
  minFreedPercent: number;
  maxPasses: number;
};

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal' | 'phrasing'>> = {};
  for (const key of [
    'keepThreshold',
    'minYieldChars',
    // `targetReduction` is the main dial and the manifest has always offered it,
    // but it was missing from this list, so setting it did nothing.
    'targetReduction',
    'preserveRecentMessages',
    'maxCallStateTokens',
    'truncateHeadChars',
    'concurrency',
    'maxKeptChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  /**
   * Clamped, because every one of these three has a value that breaks the loop
   * quietly rather than loudly.
   *
   * `compactAtPercent: 0` fires `turn.complete` on every turn AND makes the
   * derived window in `decideHandover` a hundred times too big, so every pass
   * is handed over: a model summary every other turn. `minFreedPercent: 0`
   * takes every pass straight to the ceiling. `maxPasses: 0` means kompact
   * never compacts at all while still being installed and logging.
   *
   * The floors are the smallest values that still mean what the option says:
   * compact somewhere inside the window, require a pass to free something,
   * answer at least one compaction.
   */
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: clamp(
      optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent), 1, 99),
    minFreedPercent: clamp(
      optionNumber(options, 'minFreedPercent', HOOK_DEFAULTS.minFreedPercent), 0.1, 100),
    maxPasses: Math.round(clamp(
      optionNumber(options, 'maxPasses', HOOK_DEFAULTS.maxPasses), 1, 100)),
  };
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  // The built-in scorer reads each question's instructions as well as the state,
  // so wording is not inert here even though it was introduced for the sidecar.
  const phrasing = optionString(options, 'phrasing');
  if (phrasing === 'reproducible' || phrasing === 'direct' || phrasing === 'entailment') {
    config.phrasing = phrasing;
  }
  return config;
}

/**
 * The scorer. There is one now.
 *
 * The optional Laya sidecar is gone from the product and kept in the evaluation,
 * where its findings stay reproducible. The reason is ranking quality measured
 * the same way for both, over ten grouped splits of the same 1,063 labelled
 * calls: AUC 0.905 +/- 0.078 here against 0.719 +/- 0.026 for the best
 * checkpoint and wording, won on 10 of 10 paired splits. A sidecar that also
 * wants a GPU, several GB resident and a 6.5 s cold start has to win on quality
 * to be worth its dependency, and it did not.
 *
 * Quality is the reason, and it is the only one stated here on purpose. The cost
 * side of that argument is being re-measured: the benchmark behind the published
 * figures ran against a sidecar pinned to LAYA_DEVICE=cpu while the card sat
 * idle, so its latency numbers are not the cost of running Laya. Nothing about
 * the ranking result depends on them.
 */
export function askerFor(weights?: Weights): Asker {
  return FeatureAsker.fromWeights(weights);
}

/**
 * Weights refitted on this operator's own sessions, if they ran `calibrate`.
 *
 * Read from the environment, then from `settings.json`'s `env` block. Not from a
 * file, though `$.fs.read` does exist and this comment used to claim otherwise:
 * a path would have to be configured somewhere anyway, and the JSON in
 * `KOMPACT_WEIGHTS` is the thing `npm run calibrate` already prints.
 *
 * This matters because the shipped defaults are fitted on one person's 18
 * sessions. Another operator's tool mix differs, so a local fit should win. A
 * broken value is reported and ignored rather than allowed to change decisions
 * silently.
 */
export async function readLocalWeights(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  log: (text: string) => void,
): Promise<Weights | undefined> {
  // Either channel may be absent on a given host — an engine without `$.env`
  // throws here rather than returning undefined — and neither is worth failing
  // a compaction over, so every lookup degrades to the shipped weights. Written
  // as `$.env.get`, not `$.env?.get`: the plugin validator reads an optional
  // chain as using `$.env` as a value, and the catch already covers the case.
  let raw: string | undefined;
  try {
    // The literal name, not `WEIGHTS_ENV`: the validator lists the variables a
    // module reads, and cannot do that through an identifier.
    raw = await $.env.get('KOMPACT_WEIGHTS');
  } catch {
    raw = undefined;
  }
  if (!raw) {
    try {
      const env = (await $.settings.read())['env'];
      const value = env && typeof env === 'object' ? (env as Record<string, unknown>)[WEIGHTS_ENV] : undefined;
      if (typeof value === 'string') raw = value;
    } catch {
      return undefined;
    }
  }
  if (!raw) return undefined;
  try {
    const weights = parseWeights(raw);
    log(`using locally calibrated weights${weights.fittedOn ? ` (${weights.fittedOn})` : ''}`);
    return weights;
  } catch (error) {
    log(`ignoring ${WEIGHTS_ENV}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// Both summaries spread the source so engine-owned fields the library does not
// read (result, agentId, durationMs) are carried through rather than dropped.
function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary = { ...tool } as ToolUseSummary;
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return { ...result, isError: result.isError ?? false } as ToolResultSummary;
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = { result: CompactResult; messages: SessionMessage[] };

/** Runs the library over a session transcript. Throws so the caller can fall back. */
/**
 * The whole scoring path, with no way out to the network.
 *
 * This took a `fetchFn` and a `sleep` its body never read — leftovers from the
 * sidecar, kept for a timeout guard around an HTTP call that no longer happens.
 * They cost more than dead code: the hook had to build a `$.http.fetch` closure
 * to pass one, so `claude plugin validate` listed `$.http.fetch` among the
 * capabilities this plugin uses, while the page's masthead says "no network
 * call — no exceptions and no optional path that has any". Now the validator's
 * own output is the proof of that sentence.
 */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  weights?: Weights,
): Promise<SessionCompaction> {
  const result = await compact(messages, askerFor(weights), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.failedRequests > 0 ? `${stats.failedRequests} scoring failures (kept)` : '',
    // Silent truncation is the one failure that would otherwise be invisible.
    stats.truncatedRequests > 0 ? `${stats.truncatedRequests} STATES TRUNCATED` : '',
  ].filter(Boolean);
  // `stats.ms` is the whole `compact()` call — collect, score, decide, rebuild —
  // not the scoring alone, and saying "scored ... in Xms" read as if it were.
  // The number a reader wants is how long compaction took, so say that.
  return `${percent(reductionRatio(result))} reduction; ${parts.join(', ') || 'no tool calls'}; ` +
    `${stats.requests} scored; compacted in ${stats.ms}ms`;
}

/**
 * One transcript's compaction history.
 *
 * `lastTurn` is `$.session.turns()` at the last taken pass, and exists because
 * `$.session.usage()` reports the tokens the *last response* was answered over:
 * it is stale for a turn or two after a compaction, so a `turn.complete` that
 * trusted it would ask for another compaction immediately.
 */
export type PassRecord = { passes: number; lastTurn: number; lastAt: number };
export type PassStore = Record<string, PassRecord>;

/**
 * Keyed by transcript, and by agent within it.
 *
 * A subagent's compaction is a different transcript — `event.messages` is that
 * loop's — and its short-lived passes must not spend the main session's ceiling.
 */
export function passKey(sessionId: string, agentId?: string): string {
  return `${sessionId}|${agentId ?? 'main'}`;
}

/** Newest `limit` records. The store is shared with the recorder under one cap. */
export function prunePasses(store: PassStore, limit: number = PASSES_KEPT): PassStore {
  const entries = Object.entries(store).sort((a, b) => b[1].lastAt - a[1].lastAt);
  return Object.fromEntries(entries.slice(0, limit));
}

export function asPassStore(value: unknown): PassStore {
  if (!value || typeof value !== 'object') return {};
  const out: PassStore = {};
  for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
    if (!row || typeof row !== 'object') continue;
    const { passes, lastTurn, lastAt } = row as Partial<PassRecord>;
    if (typeof passes !== 'number') continue;
    out[key] = {
      passes,
      lastTurn: typeof lastTurn === 'number' ? lastTurn : 0,
      lastAt: typeof lastAt === 'number' ? lastAt : 0,
    };
  }
  return out;
}

/**
 * Whether to answer this compaction or let the engine summarise.
 *
 * The bar is percentage points of the context window, not a fraction of the
 * transcript, because the window is what runs out. `minReductionRatio: 0.25`
 * asked the other question and answered it wrongly: measured over 16 real
 * compactions in `eval/passes.ts` it took 2, and both were a 29-message session
 * that was almost entirely one tool result. On the sessions long enough to be
 * compacted twice it took none at all, so the plugin handed every one of them
 * to the model summary while it could still free 10 points of window in 13 ms.
 * The same passes at a 5-point floor: 12 of 16.
 *
 * The floor is also the hysteresis band. A taken pass leaves the fill at least
 * `minFreedPercent` below `compactAtPercent`, so the session has to grow back
 * through it before `turn.complete` asks again — compacting every turn is not
 * possible, rather than merely discouraged.
 *
 * Handing over is measured, not a taste call: `applyDecisions` never touches
 * prose, so kompact's only material is tool inputs and outputs. "A pass can no
 * longer reclaim the floor" and "what is left is prose only a summary can
 * compress" are the same condition.
 */
export function decideHandover(input: {
  freedTokens: number;
  tokensBefore: number;
  windowTokens: number;
  passes: number;
  config: Pick<HookConfig, 'minFreedPercent' | 'maxPasses' | 'compactAtPercent'>;
}): { take: boolean; why: string } {
  const { freedTokens, tokensBefore, windowTokens, passes, config } = input;
  // The engine only asks at the trigger, so a live context of `tokensBefore`
  // stands for a window of `tokensBefore / compactAtPercent`. That is the
  // fallback when `$.session.usage()` does not say, and it is right in the
  // case that matters rather than merely safe.
  const window = windowTokens > 0
    ? windowTokens
    : (tokensBefore * 100) / Math.max(1, config.compactAtPercent);
  const floor = (window * config.minFreedPercent) / 100;
  const points = (100 * freedTokens) / Math.max(1, window);
  if (passes >= config.maxPasses) {
    return { take: false, why: `${passes} passes already; the summary carries the narrative` };
  }
  if (freedTokens < floor) {
    return {
      take: false,
      why: `freed ${points.toFixed(1)}% of the context window, under the ${config.minFreedPercent}% floor`,
    };
  }
  return { take: true, why: `freed ${points.toFixed(1)}% of the context window` };
}

/**
 * The line a reader sees, and the one the page quotes.
 *
 * Exported and pure so the page's example can be bound to it. The `summarize`
 * half was already bound and the wrapper around it was not, so the pass counter
 * arrived and the page went on showing a notice that had not existed for a
 * version — on the one string someone compares against their own terminal.
 */
export function compactionNotice(input: {
  kept: number; before: number; pass: number; maxPasses: number; why: string; result: CompactResult;
}): string {
  const { kept, before, pass, maxPasses, why, result } = input;
  return `kept ${kept}/${before} messages, no summary ` +
    `(pass ${pass} of ${maxPasses}, ${why}; ${summarize(result)})`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    // `unrepeatable` stays in the log: it is a decision the scorer did not make,
    // which is exactly the kind a reader checking the log wants to see.
    .filter((d) => d.reason !== 'pinned')
    .map((d) => `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`)
    .join(' ');
}

export function decisionLogLines(result: CompactResult, maxChars: number = UI_LOG_MAX_CHARS): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1 ? `decisions: ${chunk}` : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

function notify(
  $: { ui: { log: (text: string) => void; toast: (text: string, options?: { timeoutMs?: number }) => void } },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

/**
 * The pass store. `$` may only reach a top-level function, and such a function
 * may not be exported — so these two are the whole surface that touches it.
 */
type PassEngine = {
  store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> };
};

type HandoverEngine = PassEngine & {
  session: { id: () => Promise<string>; turns: () => Promise<number> };
  clock: { now: () => Promise<number> };
};

async function readPasses($: PassEngine): Promise<PassStore> {
  try {
    return asPassStore(await $.store.get(PASSES_KEY));
  } catch {
    return {};
  }
}

/**
 * Bookkeeping must not fail a compaction that worked.
 *
 * Everything the pass counter needs — the session id, the turn number, the
 * clock — is an engine call that can reject, and the handler's catch turns any
 * throw into "fall back to the built-in summary". That is the right answer when
 * *scoring* failed and the wrong one when the compaction is sitting there
 * finished and only the id lookup went wrong.
 */
async function askOr<T>(ask: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await ask();
  } catch {
    return fallback;
  }
}

/**
 * Record that the engine's summary just ran for this transcript.
 *
 * The count goes to zero because the summary rewrites the transcript and the
 * next kompact pass is pass 1 again; the turn stays, because it is the cooldown
 * and the moment straight after a model call is exactly when it must hold.
 * Both the hand-over path and the failure path go through here, so they cannot
 * drift apart again.
 */
async function markHandedOver($: HandoverEngine, agentId?: string): Promise<void> {
  const store = await readPasses($);
  const key = passKey(await askOr(() => $.session.id(), 'unknown'), agentId);
  store[key] = {
    passes: 0,
    lastTurn: await askOr(() => $.session.turns(), 0),
    lastAt: await askOr(() => $.clock.now(), 0),
  };
  await writePasses($, store);
}

async function writePasses($: PassEngine, store: PassStore): Promise<void> {
  try {
    await $.store.set(PASSES_KEY, prunePasses(store));
  } catch { /* a full store must not fail a compaction */ }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let compacting = false;

  // `hooks.json` names exactly one module per plugin — a second entry is refused —
  // so the recorder is registered from here rather than listed beside this file.
  // It shares nothing with compaction and returns `next(event)` on every path.
  // `on("turn.complete")` may not be registered twice without a matcher either,
  // a value derived from `on` may not be kept, and `$` may not cross an import —
  // so the recorder owns its own events end to end and this line is the whole
  // connection between the two capabilities.
  registerSignals(on, options);

  on('session.compact', async ($, event, next) => {
    try {
      const weights = await readLocalWeights($, (text) => $.ui.log(text));
      const { result, messages } = await compactSession(event.messages, config, weights);
      for (const line of decisionLogLines(result)) $.ui.log(line);

      // A precompute never lands — its result is kept for a compaction that may
      // not come — so it must not spend a pass off the ceiling.
      const speculative = event.trigger === 'precompute';
      const store = speculative ? {} : await readPasses($);
      const key = speculative
        ? ''
        : passKey(await askOr(() => $.session.id(), 'unknown'), event.agentId);
      const seen = store[key]?.passes ?? 0;
      let windowTokens = 0;
      try {
        windowTokens = (await $.session.usage()).context.window ?? 0;
      } catch { /* the fallback in decideHandover derives one from the trigger */ }
      const { stats } = result;
      const verdict = decideHandover({
        freedTokens: stats.tokensBefore - stats.tokensAfter,
        tokensBefore: stats.tokensBefore,
        windowTokens,
        passes: seen,
        config,
      });
      if (!verdict.take) {
        /**
         * Handing over resets the count but keeps the turn.
         *
         * The count, because once the engine rewrites the transcript the next
         * kompact pass is pass 1 again. The turn, because `turn.complete` reads
         * a `usage()` that is stale for a turn or two either way: deleting the
         * record outright removed the cooldown exactly when the engine had just
         * spent a model call, so the next turn asked for another compaction and
         * got a second summary of an already-summarised transcript.
         */
        if (!speculative) await markHandedOver($, event.agentId);
        notify($, `fallback to built-in summary (${verdict.why}: ${summarize(result)})`);
        return next(event);
      }
      if (!speculative) {
        store[key] = {
          passes: seen + 1,
          lastTurn: await askOr(() => $.session.turns(), 0),
          lastAt: await askOr(() => $.clock.now(), 0),
        };
        await writePasses($, store);
      }
      notify($, compactionNotice({
        kept: messages.length, before: event.messages.length,
        pass: seen + 1, maxPasses: config.maxPasses, why: verdict.why, result,
      }));
      return { messages, tokensBefore: stats.tokensBefore, tokensAfter: stats.tokensAfter };
    } catch (error) {
      /**
       * Any failure at all falls back rather than risking a broken session —
       * and leaves the cooldown behind, which this did not.
       *
       * `turn.complete` skips only when it finds a record. A throwing
       * compaction wrote none, so the engine spent a model call summarising,
       * `usage()` still read above the trigger a turn later, and the next turn
       * asked again: one summary per turn for as long as the fault lasted. The
       * hand-over path already gets this right; the failure path is the one
       * that most needs it.
       */
      if (event.trigger !== 'precompute') await markHandedOver($, event.agentId);
      notify($, `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`);
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < config.compactAtPercent) return next(event);
      /**
       * `context.tokens` is what the *last response* was answered over, so for a
       * turn or two after a compaction it still reads above the trigger. The
       * band in `decideHandover` makes thrash impossible in principle; this
       * makes it impossible before the engine's own number catches up.
       */
      const store = await readPasses($);
      // Keyed by agent as well, because `session.compact` writes it that way: a
      // subagent's taken pass stored `sess|agent-7` and this looked under
      // `sess|main`, found nothing, and recompacted on exactly the stale
      // `usage()` the cooldown exists for.
      const record = store[passKey(await askOr(() => $.session.id(), 'unknown'), event.agentId)];
      const turns = await askOr(() => $.session.turns(), 0);
      if (record && turns - record.lastTurn < COOLDOWN_TURNS) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(`auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
