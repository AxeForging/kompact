import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { registerSignals } from './laya-signals.js';
import { compact, reductionRatio } from '../src/compact.js';
import { FeatureAsker, WEIGHTS_ENV, parseWeights, type Weights } from '../src/features.js';
import { buildSystemOneRequest, parseSystemOneResponse } from '../src/request.js';
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
  minReductionRatio: 0.25,
  scorer: 'features' as const,
};

export type HookFetchInit = { method?: string; headers?: Record<string, string>; body?: string };
export type HookFetchResponse = { status: number; ok: boolean; text: string };
/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type Scorer = 'features' | 'laya';

export type HookConfig = CompactOptions & {
  scorer: Scorer;
  layaUrl?: string;
  /** Per-request deadline for the sidecar; see `withDeadline`. */
  requestTimeoutMs?: number;
  compactAtPercent: number;
  minReductionRatio: number;
};

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
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    scorer: optionString(options, 'scorer') === 'laya' ? 'laya' : HOOK_DEFAULTS.scorer,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(options, 'minReductionRatio', HOOK_DEFAULTS.minReductionRatio),
  };
  const layaUrl = optionString(options, 'layaUrl');
  if (layaUrl) config.layaUrl = layaUrl;
  const timeout = options['requestTimeoutMs'];
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) {
    config.requestTimeoutMs = timeout;
  }
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  // Only meaningful with `scorer: laya` — the built-in scorer reads facts, not
  // wording. Unreachable until now: `phrasing` existed so the wording comparison
  // could be re-run, and no plugin option carried it through.
  const phrasing = optionString(options, 'phrasing');
  if (phrasing === 'reproducible' || phrasing === 'direct' || phrasing === 'entailment') {
    config.phrasing = phrasing;
  }
  return config;
}

/** Per-request deadline for the sidecar. A local call is milliseconds. */
export const LAYA_TIMEOUT_MS = 30_000;

/** Waits `ms`. The engine supplies `$.clock.sleep`; a hook has no raw timers. */
export type Sleep = (ms: number) => Promise<void>;

/**
 * Rejects if `work` has not settled within `ms`.
 *
 * `$.http.fetch` takes no timeout — `HttpInit` has no field for one — so a hung
 * sidecar would otherwise never settle, and the "any failure falls back to the
 * built-in summary" guarantee only fires on a *rejection*. A sidecar that
 * accepts the connection and then stalls would make `session.compact` never
 * return, which reads to the user as a frozen session rather than a failed
 * scorer. Note a hook has no `setTimeout`: the deadline is `$.clock.sleep`,
 * and without one supplied the call is simply awaited unguarded.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  what: string,
  sleep?: Sleep,
): Promise<T> {
  if (!sleep) return work;
  // Once the deadline wins the race nothing is left awaiting `work`, and a
  // sidecar that rejects a moment later would surface as an unhandled rejection.
  work.catch(() => {});
  let done = false;
  const guard = sleep(ms).then(() => {
    if (!done) throw new Error(`${what} did not respond within ${ms}ms`);
    return undefined as never;
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    done = true;
  }
}

/** A `Asker` over the engine's `$.http.fetch`, for the optional Laya sidecar. */
export function layaAsker(
  fetchFn: HookFetch,
  baseUrl?: string,
  timeoutMs = LAYA_TIMEOUT_MS,
  sleep?: Sleep,
): Asker {
  return {
    async ask(state, questions) {
      const request = buildSystemOneRequest({ baseUrl }, state, questions);
      const response = await withDeadline(
        fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }),
        timeoutMs,
        `laya sidecar at ${request.url}`,
        sleep,
      );
      return parseSystemOneResponse(response.status, response.ok, response.text);
    },
  };
}

/**
 * `features` by default, and deliberately: measured on 721 labelled calls from
 * real sessions, the built-in logistic model reaches AUC 0.895 ± 0.072 where
 * the best zero-shot Laya checkpoint and phrasing reached 0.721 ± 0.021 over the
 * same ten grouped splits (`eval/RESULTS.md`) — and it needs no
 * sidecar, no GPU and no network call.
 */
export function askerFor(
  config: HookConfig,
  fetchFn: HookFetch,
  weights?: Weights,
  sleep?: Sleep,
): Asker {
  return config.scorer === 'laya'
    ? layaAsker(fetchFn, config.layaUrl, config.requestTimeoutMs, sleep)
    : FeatureAsker.fromWeights(weights);
}

/**
 * Weights refitted on this operator's own sessions, if they ran `calibrate`.
 *
 * Read from the environment, then from `settings.json`'s `env` block. Not from a
 * file, though `$.fs.read` does exist and this comment used to claim otherwise:
 * a path would have to be configured somewhere anyway, and the JSON in
 * `LAYA_COMPACT_WEIGHTS` is the thing `npm run calibrate` already prints.
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
    raw = await $.env.get('LAYA_COMPACT_WEIGHTS');
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
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  weights?: Weights,
  sleep?: Sleep,
): Promise<SessionCompaction> {
  const result = await compact(messages, askerFor(config, fetchFn, weights, sleep), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult, scorer: Scorer): string {
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
  const via = scorer === 'laya' ? `laya/${stats.checkpoint || '?'}` : 'features';
  return `${percent(reductionRatio(result))} reduction; ${parts.join(', ') || 'no tool calls'}; ` +
    `${stats.requests} scored via ${via} in ${stats.ms}ms`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
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
      const { result, messages } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        weights,
        (ms) => $.clock.sleep(ms),
      );
      for (const line of decisionLogLines(result)) $.ui.log(line);
      // Too little saved is not worth losing the summary's narrative over.
      if (reductionRatio(result) < config.minReductionRatio) {
        notify($, `fallback to built-in summary (below ${percent(config.minReductionRatio)}: ${summarize(result, config.scorer)})`);
        return next(event);
      }
      notify($, `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result, config.scorer)})`);
      return { messages };
    } catch (error) {
      // Any failure at all falls back rather than risking a broken session.
      notify($, `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`);
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < config.compactAtPercent) return next(event);
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
