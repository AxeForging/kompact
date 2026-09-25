import type { SystemOneQuestions, ToolCall } from './types.js';

/**
 * Question phrasings. Laya is an encoder doing something close to textual
 * entailment and is very sensitive to wording: its own docs record "blocked by
 * a barrier" separating classes by 0.75 where "blocked by a train" managed
 * 0.45, and — crucially — that asking *what to do* ("which way must the bird
 * move?") came out inverted on every checkpoint while asking *what is true*
 * ("where is the bird?") gave clean graded answers.
 *
 * Both upstreams ask a what-to-do question ("should this stay in the
 * history?"). `reproducible` asks what is true of the text instead, which is
 * also the property the decision actually turns on: re-running a tool recovers
 * a file, but never recovers a test failure. The other two exist so Phase 4 can
 * measure them against labels rather than us guessing (`eval/score.ts`).
 */
export type Phrasing = 'reproducible' | 'direct' | 'entailment';

export const DEFAULT_PHRASING: Phrasing = 'reproducible';

/**
 * The two `noul` questions asked about one call. Names must stay
 * `call_<id>`/`result_<id>` — the scorer reads them back by those names.
 */
export function questionsFor(call: ToolCall, phrasing: Phrasing = DEFAULT_PHRASING): SystemOneQuestions {
  switch (phrasing) {
    case 'direct':
      return {
        [`call_${call.id}`]: {
          type: 'noul',
          instructions:
            'Knowing that this tool call was made, with its input, still matters for what the assistant does next',
          criteria: { true: 'still matters', false: 'droppable together with its output' },
        },
        [`result_${call.id}`]: {
          type: 'noul',
          instructions:
            'The full output of this tool call should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do',
          criteria: { true: 'needed verbatim', false: 'droppable, re-running can recover it' },
        },
      };
    case 'entailment':
      return {
        [`call_${call.id}`]: {
          type: 'noul',
          instructions: 'The text says the assistant is still working on this file or command',
          criteria: { true: 'still being worked on', false: 'finished or unrelated' },
        },
        [`result_${call.id}`]: {
          type: 'noul',
          instructions: 'The text says this output could not be obtained again',
          criteria: { true: 'could not be obtained again', false: 'could be obtained again' },
        },
      };
    case 'reproducible':
    default:
      return {
        [`call_${call.id}`]: {
          type: 'noul',
          instructions: 'The task described above still concerns the thing this tool call acted on',
          criteria: {
            true: 'the same file, command or page is still part of the current task',
            false: 'it belongs to work that is finished or unrelated',
          },
        },
        [`result_${call.id}`]: {
          type: 'noul',
          instructions:
            'This output is a one-off observation that running the tool again would not reproduce, such as an error message, a test failure, or what a command printed at one moment',
          criteria: {
            true: 'a one-off observation that exists only in this text',
            false: 'a stable file or listing that re-running the tool would reproduce',
          },
        },
      };
  }
}
