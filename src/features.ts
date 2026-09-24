/**
 * The shipped scorer: a logistic model over facts already computed while
 * building a call's state. No model call, no sidecar, no network, no GPU.
 *
 * This exists because it was measured to be better, repeatedly. Over 1063
 * labelled calls from 18 real sessions: leave-one-session-out AUC 0.862, and
 * across 10 grouped splits holding out 30% of sessions each time it averages
 * 0.895 (sd 0.073, worst split 0.687) against 0.721 for the best Laya
 * checkpoint and phrasing. It won 10 of 10 splits — though by as little as
 * 0.002 on the closest one. At a 90% safety setting it frees 39% of tool-output
 * characters against Laya's 12%. The features carry the signal, and an encoder
 * asked to read the same facts as prose does worse.
 *
 * Earlier drafts of this comment claimed 0.917 from a single split on 721 calls.
 * Repeated evaluation on a wider corpus put it at 0.895 and Laya's best rose
 * from 0.694 to 0.721: one split flatters whatever it measures.
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
 * Fitted on 1063 labelled calls from 18 real sessions (`eval/fit.ts`).
 * Leave-one-session-out: AUC 0.862, ECE 0.019.
 * `size=long` and `age=a while back` are the reference levels, hence absent.
 */
export const KEEP_RESULT_WEIGHTS: readonly number[] = [
  -0.515007, -0.479497, -1.354382, -2.356925, 0.0, -0.854025, 2.120442, 0.033473,
  -3.085024, -1.400197, -1.648371, 0.037077, -0.356110,
];

/** Same fit, for whether the call itself still matters. LOSO AUC 0.971, ECE 0.026. */
export const KEEP_CALL_WEIGHTS: readonly number[] = [
  -0.562089, -0.749362, -1.413913, 0.469736, 0.0, -0.242158, 3.793540, 5.486919,
  -2.518247, -0.957991, -0.588688, 0.054670, 0.046405,
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
export interface Weights {
  keepResult: readonly number[];
  keepCall: readonly number[];
  /** Free-form note: which corpus these came from, when, and how they scored. */
  fittedOn?: string;
}

/**
 * Environment variable carrying weights refitted on the operator's own
 * sessions, as JSON. `eval/calibrate.ts` produces its value. Hooks have no
 * filesystem, so this is the channel rather than a file path.
 */
export const WEIGHTS_ENV = 'LAYA_COMPACT_WEIGHTS';

/**
 * Validates a weights file. Shipped defaults are fitted on one person's
 * sessions; a different operator's tools and habits differ, so refitting
 * locally is expected. A malformed file must never be silently half-applied.
 */
export function parseWeights(text: string): Weights {
  const parsed: unknown = JSON.parse(text);
  const ok = (value: unknown): value is number[] =>
    Array.isArray(value) &&
    value.length === FEATURE_NAMES.length &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v));
  const record = parsed as { keepResult?: unknown; keepCall?: unknown; fittedOn?: unknown };
  if (!ok(record.keepResult) || !ok(record.keepCall)) {
    throw new Error(
      `weights must hold keepResult and keepCall, each ${FEATURE_NAMES.length} finite numbers`,
    );
  }
  const weights: Weights = { keepResult: record.keepResult, keepCall: record.keepCall };
  if (typeof record.fittedOn === 'string') weights.fittedOn = record.fittedOn;
  return weights;
}

export class FeatureAsker implements Asker {
  constructor(
    private readonly keepResult: readonly number[] = KEEP_RESULT_WEIGHTS,
    private readonly keepCall: readonly number[] = KEEP_CALL_WEIGHTS,
  ) {}

  /** An asker using weights refitted locally, or the shipped ones. */
  static fromWeights(weights?: Weights): FeatureAsker {
    return weights === undefined
      ? new FeatureAsker()
      : new FeatureAsker(weights.keepResult, weights.keepCall);
  }

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
