import type { Phrasing } from './questions.js';

export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
  /**
   * Fields the engine owns and this package only carries through. They are not
   * read by the scorer, but rebuilding a tool block without them loses them
   * from the transcript permanently — an `Agent` call whose result is truncated
   * would forget which subagent produced it.
   */
  result?: unknown;
  agentId?: string;
  durationMs?: number;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
  /** Carried through, not read; see `ToolUse.result`. */
  result?: unknown;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  /** The tool output itself; the per-call state excerpts it. */
  resultText: string;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

/**
 * Facts about one call, already reduced to words. Every comparison and count
 * happens in `state.ts`; the model only ever reads a sentence.
 */
export interface CallContext {
  /** How far back the call sits, e.g. `long ago in the session`. */
  age: string;
  /** Output size as words, e.g. `very long`. */
  size: string;
  /** A later call changed the same target, so this output is stale. */
  targetTouchedAfter: boolean;
  /** The assistant ran the same tool on the same target again later. */
  rerunLater: boolean;
}

export interface CallAnswer {
  /** Probability that the call itself still matters. */
  keepCall: number;
  /** Probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  /**
   * `budget` means it scored low but the reduction target was already met;
   * `too small` that dropping it would have freed less than it risked.
   */
  reason: 'pinned' | 'kept' | 'budget' | 'too small' | 'result_dropped' | 'call_dropped';
}


export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /**
   * Score at or above which a call is never dropped, whatever the reduction
   * target asks for. A floor, not a cut — see `targetReduction`. Default 0.1.
   */
  keepThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /**
   * Estimated token ceiling for ONE call's state. Default 700, which sits under
   * the multilingual checkpoint's 768-token state budget; anything above the
   * checkpoint's context length is discarded silently by the server.
   */
  maxCallStateTokens?: number;
  /** Requests in flight at once. Default 8. */
  concurrency?: number;
  /**
   * Fraction of droppable tool-output characters to free, 0-1. Default 0.5.
   *
   * The scorer produces a ranking; a fixed probability cut turns that ranking
   * into a decision badly, because each session has its own distribution. A
   * Bash-heavy session scores low across the board and an absolute cut sweeps
   * all of it; a session of file reads scores high and the same cut frees
   * nothing. Dropping from the lowest score upward until this much is freed
   * adapts to either without anyone tuning a threshold.
   *
   * `keepThreshold` still wins: nothing at or above it is dropped to meet this
   * budget, so on a session where everything matters, little is freed.
   *
   * 0.5 rather than 0.7 because a wrong drop costs work and under-freeing only
   * costs context. Measured per session on the labelled corpus: 0.5 frees 23.4%
   * of tool output and leaves 92.2% of the characters that were reused later;
   * 0.7 frees 33.9% and leaves 90.2%.
   */
  targetReduction?: number;
  /** Question wording variant. Default `reproducible`. */
  phrasing?: Phrasing;
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number;
  /**
   * Fewest characters a drop must actually free to be worth making. Default 200.
   *
   * Dropping an 89-character `Grep` result freed 126 characters — about thirty
   * tokens — in exchange for a real chance of losing something the session went
   * on to need. Below this floor the ranking is not worth acting on, whatever it
   * says, because the upside cannot repay the risk.
   */
  minYieldChars?: number;
  /**
   * Longest a KEPT tool result may be, in characters. Default 24,000; 0 disables.
   *
   * The ranking decides which outputs to drop. This decides how much of the ones
   * it keeps is worth carrying, and it is a separate question, because output
   * size is brutally lopsided: measured over 68 sessions and 5,151 calls on one
   * machine, half of all output characters live in about 3% of the calls.
   *
   * `eval/where-reused.ts` asks where inside a reused output the reuse falls.
   * The answer is: everywhere — median depth 0.46 of the way through, only 9%
   * of reused passages inside the first tenth — so a cap is close to sampling
   * the output at random, and a tail window does not beat a plain head (it
   * measured slightly worse at every budget).
   *
   * What makes a cap worth having anyway is the size distribution.
   * `eval/cap.ts` scores both levers on one corpus by one measure, the share of
   * later-quoted passages still present:
   *
   *     ranking only (shipped)   24.2% freed   83.0% of quoted passages kept
   *     cap 24,000 added         26.8% freed   82.9%
   *     cap 16,000 added         30.6% freed   82.2%
   *     cap 8,000 added          43.3% freed   79.3%
   *     cap 8,000, no ranking    31.8% freed   96.1%
   *
   * The last row is the uncomfortable one and it is reported rather than buried:
   * on aggregate, a cap with no model beats the shipped ranking on both axes at
   * once. Per session it is less flattering — the cap has sessions that lose
   * every quoted passage, which the ranking does not — so this ships as an
   * addition to the ranking and not a replacement for it.
   *
   * 24,000 is the default because it is the largest setting measured to leave
   * the tail exactly as it is: across the 46 sessions with ten or more quoted
   * passages, the tenth percentile (66.7%), the worst session (37.5%) and the
   * number of sessions keeping under half (2) are identical to shipping no cap
   * at all, while the median session frees 9.6% instead of 7.3%. 16,000 doubles
   * the median session's saving and costs one more such session; that is a
   * defensible setting, and it is not the one a default should take on the
   * reader's behalf.
   */
  maxKeptChars?: number;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxCallStateTokens: number;
  concurrency: number;
  targetReduction: number;
  phrasing: Phrasing;
  truncateHeadChars: number;
  minYieldChars: number;
  maxKeptChars: number;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    /**
     * Largest per-question-row token count any request read. NOT
     * `usage.input_tokens`, which is that figure times the number of questions.
     */
    maxRowTokens: number;
    /**
     * Requests whose state the server truncated — detected by comparing
     * reported `input_tokens` against the checkpoint's context length. Any
     * value above zero means some decisions were made on partial states.
     */
    truncatedRequests: number;
    /** Checkpoint the router actually used, from `routing.model`. */
    checkpoint: string;
    requests: number;
    /** Requests that failed; their calls are kept, never dropped. */
    failedRequests: number;
    ms: number;
  };
}

/** The `state` of a System One request: a string or any JSON-serialisable object. */
export type SystemOneState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type SystemOneQuestions = Record<string, SystemOneQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
  model?: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Anything that can answer the two questions: `FeatureAsker` (default),
 * `LayaClient` (a sidecar), or a host-provided adapter. */
export interface Asker {
  ask(state: SystemOneState, questions: SystemOneQuestions): Promise<SystemOneResponse>;
}
