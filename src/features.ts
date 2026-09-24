/**
 * The shipped scorer: a logistic model over facts already computed while
 * building a call's state. No model call, no sidecar, no network, no GPU.
 *
 * This exists because it was measured to be better. Against 721 labelled calls
 * from real sessions, leave-one-session-out, this scores AUC 0.917 where the
 * best Laya checkpoint and phrasing managed 0.694; at a 90% safety setting it
 * frees 26% of tool-output characters against Laya's 4.5%. The features carry
 * the signal, and an encoder asked to read the same facts as prose does worse.
 *
 * Laya stays available behind the same `Asker` seam (`LayaClient`) for anyone
 * with a checkpoint fine-tuned on their own sessions — the bar it has to clear
 * is this file, not chance.
 */
import type { Asker, SystemOneQuestions, SystemOneResponse, SystemOneState } from './types.js';

export const FEATURE_NAMES = [
  'bias',
  'tool=Read',
  'tool=Bash',
  'tool=Edit|Write',
  'tool=Grep|Glob',
  'isError',
  'targetChangedAfter',
  'targetReadAgain',
  'size=very short',
  'size=short',
  'size=very long',
  'age=long ago',
  'age=just now',
] as const;

/** Output size in words, thresholded here because a model cannot read digits. */
function sizeBucket(chars: number): 'very short' | 'short' | 'long' | 'very long' {
  if (chars < 200) return 'very short';
  if (chars < 2_000) return 'short';
  if (chars < 20_000) return 'long';
  return 'very long';
}

/**
 * Normalises whatever a client sent into the prose this scorer reads.
 *
 * Our own states already say "The output was long."; `jev-compact` (Codex CLI)
 * instead sends one big JSON state for the whole conversation and puts the
 * per-call facts in the question instructions, as a raw character count. Both
 * are accepted, so the same server serves both hosts. Counts are bucketed here
 * rather than passed through, for the same reason they are everywhere else.
 */
export function normaliseCallText(state: string, instructions = ''): string {
  const text = `${state}\n${instructions}`;
  if (/The output was (very short|short|long|very long)\./.test(text)) return text;
  const chars = /\((?:[^)]*?, )?(\d[\d_,]*) chars\)/.exec(instructions)?.[1];
  if (chars === undefined) return text;
  const size = sizeBucket(Number(chars.replace(/[_,]/g, '')));
  return `${text}\nThe output was ${size}.`;
}

/**
 * Features are read back out of the state prose, so the scorer sees exactly the
 * information a model would have been given and nothing more. That keeps the
 * comparison fair and keeps one source of truth for what a call looks like.
 */
export function featureVector(state: string, tool: string, isError: boolean): number[] {
  return [
    1,
    tool === 'Read' ? 1 : 0,
    tool === 'Bash' ? 1 : 0,
    tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' ? 1 : 0,
    tool === 'Grep' || tool === 'Glob' ? 1 : 0,
    isError ? 1 : 0,
    state.includes('changed afterwards') ? 1 : 0,
    state.includes('again later') ? 1 : 0,
    state.includes('very short') ? 1 : 0,
    state.includes('The output was short.') ? 1 : 0,
    state.includes('very long') ? 1 : 0,
    state.includes('long ago in the session') ? 1 : 0,
    state.includes('just now') ? 1 : 0,
  ];
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function score(weights: readonly number[], features: readonly number[]): number {
  return sigmoid(features.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0));
}

/**
 * Fitted on 721 labelled calls from real sessions (`eval/fit.ts`).
 * Leave-one-session-out: AUC 0.918, ECE 0.053.
 * `size=long` and `age=a while back` are the reference levels, hence absent.
 */
export const KEEP_RESULT_WEIGHTS: readonly number[] = [
  0.181125, -0.040728, -1.652361, -2.341452, 0.0, -0.576143, 1.900781, 0.017374,
  -3.710076, -2.025578, -1.345933, 0.011502, -0.660754,
];

/** Same fit, for whether the call itself still matters. LOSO AUC 0.987, ECE 0.050. */
export const KEEP_CALL_WEIGHTS: readonly number[] = [
  0.094899, -0.645405, -1.582841, 0.400460, 0.0, -0.215684, 3.697537, 5.758080,
  -3.103545, -1.480751, -0.651458, 0.000897, -0.241406,
];

/**
 * The tool name, from our own state prose or from a `jev-compact` question
 * ("Tool call shell (call_1) should stay..." / "The full output of the shell
 * call (call_1, 2451 chars)...").
 */
export function toolFromState(state: string): string {
  return (
    /ran the (\S+) tool/.exec(state)?.[1] ??
    /output of the (\S+) call/.exec(state)?.[1] ??
    /Tool call (\S+) \(/.exec(state)?.[1] ??
    ''
  );
}

/**
 * Scores calls from the state alone, with no network call. Implements the same
 * `Asker` seam as `LayaClient`, so it is a drop-in swap and `compact()` does
 * not know the difference.
 */
export class FeatureAsker implements Asker {
  constructor(
    private readonly keepResult: readonly number[] = KEEP_RESULT_WEIGHTS,
    private readonly keepCall: readonly number[] = KEEP_CALL_WEIGHTS,
  ) {}

  async ask(state: SystemOneState, questions: SystemOneQuestions): Promise<SystemOneResponse> {
    const stateText = typeof state === 'string' ? state : JSON.stringify(state);
    const answers: Record<string, { noul: number }> = {};
    for (const [name, question] of Object.entries(questions)) {
      // Features come from the state AND this question's own instructions: our
      // states carry the per-call facts, `jev-compact`'s questions do.
      const text = normaliseCallText(stateText, question?.instructions ?? '');
      const features = featureVector(
        text,
        toolFromState(text),
        text.includes('failed and returned an error') || text.includes('(error)'),
      );
      const weights = name.startsWith('result_') ? this.keepResult : this.keepCall;
      answers[name] = { noul: score(weights, features) };
    }
    return { answers, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}
