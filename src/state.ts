import type { CallContext, Message, ToolCall, ToolResult } from './types.js';

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Cost of one non-ASCII character, by script.
 *
 * The estimator must land ABOVE the true count: overshooting the checkpoint's
 * context length is punished by silent truncation rather than by an error, so
 * an underestimate is the dangerous direction. A flat 0.9 per character — what
 * this charged before — underestimates badly outside ASCII, where a real BPE
 * tokenizer spends one to three tokens on a single CJK ideograph and several on
 * an emoji. That mattered because the `multilingual` checkpoint is the one this
 * plugin selects, so non-English sessions were exactly the case most likely to
 * overflow unnoticed.
 */
function wideCost(code: number): number {
  // Surrogate halves: an astral character (emoji, rare CJK) arrives as two.
  if (code >= 0xd800 && code <= 0xdfff) return 1.75;
  // CJK ideographs, kana, Hangul: commonly one to two tokens each.
  if (code >= 0x3040 && code <= 0x9fff) return 1.75;
  if (code >= 0xac00 && code <= 0xd7af) return 1.75;
  if (code >= 0xf900 && code <= 0xfaff) return 1.75;
  // Cyrillic, Greek, Hebrew, Arabic, accented Latin, punctuation, symbols.
  if (code > 0x7f) return 1.1;
  return 0.9;
}

/**
 * Estimates tokens without a tokenizer: a word costs one token per six letters,
 * a digit half a token, ASCII symbols nine tenths, and anything else the
 * per-script cost above. Calibrated to land above the true count.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += wideCost(first);
  }
  return Math.ceil(tokens);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultText: found.result.text,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

/** The last three user prompts, as the default `goal`. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

/** Tools whose call changes its target, so an earlier read of it is now stale. */
const MUTATING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Input keys that name what a call acted on, most specific first. */
const TARGET_KEYS = [
  'file_path',
  'notebook_path',
  'command',
  'url',
  'pattern',
  'path',
  'query',
  'prompt',
  'description',
] as const;

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A stable key for "the same thing", to compare two calls' targets. */
export function targetOf(call: Pick<ToolCall, 'input'>): string | undefined {
  for (const key of TARGET_KEYS) {
    const value = stringField(call.input, key);
    if (value !== undefined) return `${key}:${value}`;
  }
  return undefined;
}

/** What the call acted on, as a phrase — never a bare JSON blob if avoidable. */
export function describeTarget(call: Pick<ToolCall, 'input'>): string {
  const file = stringField(call.input, 'file_path') ?? stringField(call.input, 'notebook_path');
  if (file) return `on the file ${truncate(file, 120)}`;
  const command = stringField(call.input, 'command');
  if (command) return `with the command ${truncate(command.replace(/\s+/g, ' '), 120)}`;
  const url = stringField(call.input, 'url');
  if (url) return `on the page ${truncate(url, 120)}`;
  const pattern = stringField(call.input, 'pattern') ?? stringField(call.input, 'query');
  if (pattern) {
    const where = stringField(call.input, 'path');
    return `searching for ${truncate(pattern, 80)}${where ? ` in ${truncate(where, 60)}` : ''}`;
  }
  const prompt = stringField(call.input, 'prompt') ?? stringField(call.input, 'description');
  if (prompt) return `to ${truncate(prompt.replace(/\s+/g, ' '), 120)}`;
  return 'with a structured input';
}

/**
 * Output size as words, not a number. Laya cannot read numbers — its own docs
 * record that no checkpoint could tell which of two altitudes was lower — so
 * every comparison is made here and only the conclusion is handed over.
 */
export function describeSize(chars: number): string {
  if (chars < 200) return 'very short';
  if (chars < 2_000) return 'short';
  if (chars < 20_000) return 'long';
  return 'very long';
}

/** How far back the call sits, as words. Same reason as `describeSize`. */
export function describeAge(callIndex: number, total: number): string {
  const span = Math.max(1, total - 1);
  const fromEnd = (span - callIndex) / span;
  if (fromEnd > 0.75) return 'long ago in the session';
  if (fromEnd > 0.5) return 'a while back';
  if (fromEnd > 0.25) return 'earlier in the session';
  return 'just now';
}

/**
 * Per-call facts that need a scan over the whole call list. These are the
 * signals the decision actually turns on, and all of them are computed here so
 * the model is only ever asked to read a sentence.
 */
export function callContexts(
  calls: readonly ToolCall[],
  messageCount: number,
): Map<string, CallContext> {
  const contexts = new Map<string, CallContext>();
  calls.forEach((call, index) => {
    const target = targetOf(call);
    let targetTouchedAfter = false;
    let rerunLater = false;
    if (target !== undefined) {
      for (const later of calls.slice(index + 1)) {
        if (targetOf(later) !== target) continue;
        if (MUTATING.has(later.tool)) targetTouchedAfter = true;
        if (later.tool === call.tool) rerunLater = true;
      }
    }
    contexts.set(call.id, {
      age: describeAge(call.callIndex, messageCount),
      size: describeSize(call.resultChars),
      targetTouchedAfter,
      rerunLater,
    });
  });
  return contexts;
}

/** Excerpt sizes tried in order until the state fits the budget. */
const EXCERPTS: readonly (readonly [number, number])[] = [
  [2400, 700],
  [1400, 450],
  [800, 250],
  [400, 120],
  [150, 50],
  [0, 0],
];

function excerpt(text: string, head: number, tail: number): string {
  if (head === 0) return '';
  if (text.length <= head + tail + 40) return text;
  return `${text.slice(0, head)}\n[... middle omitted ...]\n${text.slice(-tail)}`;
}

export interface CallState {
  /** The prose state sent to Laya. */
  state: string;
  /** Estimated tokens, conservative. */
  tokens: number;
  /** Which excerpt rung was used; the last rung shows no output at all. */
  rung: number;
}

/**
 * Builds the state for ONE tool call, as prose, inside `budget` tokens.
 *
 * Both upstreams send the entire conversation (up to 25,000 tokens) with every
 * request and let the questions point at calls inside it. Against Laya that
 * cannot work: a request is one encoder row of
 * `[options <=256 tokens] + [state <=768 tokens]`, and anything longer is cut
 * without an error. So the state is inverted — one small state per call, which
 * is also the shape Laya's own 20-60 ms latency figures are measured on.
 */
export function buildCallState(
  call: ToolCall,
  context: CallContext,
  goal: string,
  budget: number,
): CallState {
  const facts = [
    `The assistant ran the ${call.tool} tool ${describeTarget(call)}.`,
    `That happened ${context.age}.`,
    `The output was ${context.size}.`,
  ];
  if (call.isError) facts.push('The call failed and returned an error.');
  if (context.targetTouchedAfter) {
    facts.push('The same thing was changed afterwards, so this output describes how it used to be.');
  }
  if (context.rerunLater) facts.push('The assistant ran the same tool on the same thing again later.');

  const head = `Task: ${truncate(goal.replace(/\s+/g, ' '), 300)}\n\n${facts.join(' ')}`;

  let last: CallState | undefined;
  for (let rung = 0; rung < EXCERPTS.length; rung += 1) {
    const [headChars, tailChars] = EXCERPTS[rung]!;
    const body = excerpt(call.resultText, headChars, tailChars);
    const state = body === '' ? head : `${head}\n\nThe output said:\n${body}`;
    last = { state, tokens: estimateTokens(state), rung };
    if (last.tokens <= budget) return last;
  }
  // Even the bare facts overflow (a pathological goal or target): send them
  // anyway rather than fail the compaction, and let the caller see `tokens`.
  return last!;
}
