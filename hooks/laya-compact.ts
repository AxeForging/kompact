import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

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
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `Asker` over the engine's `$.http.fetch`, for the optional Laya sidecar. */
export function layaAsker(fetchFn: HookFetch, baseUrl?: string): Asker {
  return {
    async ask(state, questions) {
      const request = buildSystemOneRequest({ baseUrl }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseSystemOneResponse(response.status, response.ok, response.text);
    },
  };
}

/**
 * `features` by default, and deliberately: measured on 721 labelled calls from
 * real sessions, the built-in logistic model reaches AUC 0.918 where the best
 * zero-shot Laya checkpoint and phrasing reached 0.694 — and it needs no
 * sidecar, no GPU and no network call.
 */
export function askerFor(config: HookConfig, fetchFn: HookFetch, weights?: Weights): Asker {
  return config.scorer === 'laya'
    ? layaAsker(fetchFn, config.layaUrl)
    : FeatureAsker.fromWeights(weights);
}

/**
 * Weights refitted on this operator's own sessions, if they ran `calibrate`.
 *
 * Read from the environment, then from `settings.json`'s `env` block — the two
 * channels a hook actually has. Hooks get no filesystem, so the weights travel
 * as JSON in `LAYA_COMPACT_WEIGHTS` rather than as a file path.
 *
 * This matters because the shipped defaults are fitted on one person's 18
 * sessions. Another operator's tool mix differs, so a local fit should win. A
 * broken value is reported and ignored rather than allowed to change decisions
 * silently.
 */
export async function readLocalWeights(
  $: {
    env?: { get: (name: string) => Promise<string | undefined> };
    settings?: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  log: (text: string) => void,
): Promise<Weights | undefined> {
  // Either channel may be absent on a given host; neither is worth failing a
  // compaction over, so every lookup degrades to the shipped weights.
  let raw: string | undefined;
  try {
    raw = await $.env?.get(WEIGHTS_ENV);
  } catch {
    raw = undefined;
  }
  if (!raw) {
    try {
      const env = (await $.settings?.read())?.['env'];
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

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return { tool_use_id: result.tool_use_id, text: result.text, isError: result.isError ?? false };
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
): Promise<SessionCompaction> {
  const result = await compact(messages, askerFor(config, fetchFn, weights), config);
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

  on('session.compact', async ($, event, next) => {
    try {
      const weights = await readLocalWeights($, (text) => $.ui.log(text));
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      }, weights);
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
