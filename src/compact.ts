import { CONTEXT_LENGTH, DEFAULT_MODEL, inputTokens, noulAnswer, routedModel } from './request.js';
import { DEFAULT_PHRASING, questionsFor } from './questions.js';
import { buildCallState, callContexts, collectToolCalls, goalFromMessages } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  Asker,
  SystemOneResponse,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  // 700 sits under the multilingual checkpoint's 768-token state budget.
  maxCallStateTokens: 700,
  concurrency: 8,
  phrasing: DEFAULT_PHRASING,
  truncateHeadChars: 300,
};

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages)),
    ),
    maxCallStateTokens: Math.max(
      64,
      Math.floor(finite(options.maxCallStateTokens, DEFAULT_OPTIONS.maxCallStateTokens)),
    ),
    concurrency: Math.max(1, Math.floor(finite(options.concurrency, DEFAULT_OPTIONS.concurrency))),
    phrasing: options.phrasing ?? DEFAULT_OPTIONS.phrasing,
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
  };
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

interface CallOutcome {
  call: ToolCall;
  answer?: CallAnswer;
  /** Tokens the encoder read for ONE question row — see `rowTokens`. */
  rowTokens?: number;
  checkpoint?: string;
  error?: unknown;
}

/**
 * Tokens the encoder actually read per question row.
 *
 * `usage.input_tokens` is the SUM over rows, not a per-request figure: every
 * question is its own row of `[options] + [state]`, so N questions against one
 * state report N times the same count. Measured: 1/2/4/8 questions on a fixed
 * state reported 323/646/1292/2584. Comparing the raw sum against the context
 * length therefore false-alarms on every multi-question request.
 */
export function rowTokens(used: number, questionCount: number): number {
  return questionCount > 0 ? used / questionCount : used;
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[laya-compact truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(tool.text ?? '', tool.isError ?? false, headChars);
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : { tool_use_id: result.tool_use_id, text, isError: result.isError };
      });
    if (
      !message.toolUses.some((tool) => actions.get(tool.tool_use_id) === 'drop_call') &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every((result, index) => result === message.toolResults?.[index])
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Laya, for every tool call outside the pinned
 * first and newest messages, two questions about a small state describing that
 * one call. One request per call, `concurrency` in flight.
 *
 * A single failed request keeps its call — the safe direction, since a wrong
 * drop is unrecoverable and a wrong keep only costs context. Every request
 * failing throws, so the caller falls back to the host's built-in compaction.
 */
export async function compact(
  messages: readonly Message[],
  asker: Asker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  const goal = resolved.goal || goalFromMessages(messages);
  const contexts = callContexts(calls, messages.length);

  const outcomes = await pool<ToolCall, CallOutcome>(
    candidates,
    resolved.concurrency,
    async (call): Promise<CallOutcome> => {
      const built = buildCallState(call, contexts.get(call.id)!, goal, resolved.maxCallStateTokens);
      const questions = questionsFor(call, resolved.phrasing);
      const questionCount = Object.keys(questions).length;
      try {
        const response: SystemOneResponse = await asker.ask(built.state, questions);
        const used = inputTokens(response);
        return {
          call,
          answer: {
            keepCall: noulAnswer(response.answers, `call_${call.id}`),
            keepResult: noulAnswer(response.answers, `result_${call.id}`),
          },
          rowTokens: used === undefined ? undefined : rowTokens(used, questionCount),
          checkpoint: routedModel(response),
        };
      } catch (error) {
        return { call, error };
      }
    },
  );

  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  if (candidates.length > 0 && failed.length === candidates.length) {
    throw new Error(
      `Laya scored no calls (${failed.length} requests failed): ${String(
        (failed[0] as CallOutcome).error,
      ).slice(0, 200)}`,
    );
  }

  const answers = new Map<string, CallAnswer>();
  let maxRowTokens = 0;
  let truncatedRequests = 0;
  let checkpoint = '';
  for (const outcome of outcomes) {
    if (outcome.answer) answers.set(outcome.call.id, outcome.answer);
    if (outcome.checkpoint) checkpoint = outcome.checkpoint;
    const used = outcome.rowTokens ?? 0;
    if (used > maxRowTokens) maxRowTokens = used;
    // The server truncates silently and still answers 200. A row that read
    // exactly the context length is the only signal that it happened.
    const limit = CONTEXT_LENGTH[outcome.checkpoint ?? DEFAULT_MODEL];
    if (limit !== undefined && used >= limit) truncatedRequests += 1;
  }

  // An unanswered call keeps both halves: a wrong keep costs context, a wrong
  // drop destroys work that cannot be recovered.
  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      maxRowTokens,
      truncatedRequests,
      checkpoint,
      requests: candidates.length,
      failedRequests: failed.length,
      ms: Date.now() - started,
    },
  };
}
