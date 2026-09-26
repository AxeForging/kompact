/**
 * Does Laya know anything the thirteen coefficients do not?
 *
 * `eval/repeat.ts` asks which scorer ranks better and answers: the logistic, on
 * 10 of 10 paired splits. That is the right question for "which one ships" and
 * the wrong one for "was the sidecar worth building". A model can lose outright
 * and still carry signal the winner lacks — and if it does, that signal is worth
 * having even though the model is not, because it can be distilled into the
 * coefficients offline and shipped as floats.
 *
 * So this asks the complementary question. Fit the same logistic on the same
 * splits, once on the 13 features and once on those features PLUS Laya's two
 * cached probabilities for the same call, and compare the two paired. Nothing
 * here runs a sidecar: the answers come from `eval/fixtures/scores.json`, so a
 * stranger with no GPU gets the same result.
 *
 * The gate was written down before the measurement, in the plan:
 *
 *   PASS if mean paired AUC gain > +0.018 — the closest margin the published
 *   comparison already tolerates — AND the augmented model wins >= 8 of 10
 *   splits. Anything less is noise, and a teacher that teaches noise is not
 *   worth fine-tuning.
 *
 * A FAIL is a real result and belongs on the page: it would mean Laya is a
 * slower way to compute what `src/features.ts` already computes from the same
 * state, which is the strongest version of the argument the page makes.
 *
 * Run: bun eval/teacher.ts [--iterations 10] [--test-frac 0.3] [--fixture]
 */
import { dot, fitLogistic as fit, sigmoid } from './logistic.js';
import { auc } from './metrics.js';
import { featureVector } from '../src/features.js';
import { loadCorpus, loadScores, rowKey } from './corpus.js';

const dir = import.meta.dirname;
const args = process.argv.slice(2);
const num = (flag: string, fallback: number): number => {
  const index = args.indexOf(flag);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const ITERATIONS = num('--iterations', 10);
const TEST_FRAC = num('--test-frac', 0.3);
const MIN_TEST_POSITIVES = 5;

/** The gate, from the plan. Named here so it cannot be moved after the fact. */
const GATE_GAIN = 0.018;
const GATE_WINS = 0.8;

const { rows, from } = loadCorpus(dir, { paired: true });
const { scores: cache, from: scoresFrom } = loadScores(dir, rows);

const sessions = [...new Set(rows.map((r) => r.session))];
const base = new Map(rows.map((r) => [rowKey(r), featureVector(r.state, r.tool, r.is_error)]));

const configs = Object.keys(cache)
  .filter((key) => rows.filter((r) => cache[key]![rowKey(r)]).length >= rows.length * 0.95)
  .sort();

/**
 * The 13 features with Laya's two answers appended.
 *
 * Both, not just `result`: `call` is the answer to the other question asked in
 * the same forward pass, and it is free. 0.5 for a missing row is the same
 * stand-in `repeat.ts` uses, and it is deliberately uninformative.
 */
function augmented(key: string, id: string): number[] {
  const answer = cache[key]![id];
  return [...base.get(id)!, answer?.result ?? 0.5, answer?.call ?? 0.5];
}

// Identical splits to eval/repeat.ts — same PRNG, same seeds, same rejection
// rule — so a difference here is the extra columns and nothing else.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const plain: number[] = [];
const withLaya = new Map<string, number[]>(configs.map((key) => [key, []]));

let iteration = 0;
let attempts = 0;
while (iteration < ITERATIONS && attempts < ITERATIONS * 50) {
  attempts += 1;
  const random = rng(1000 + attempts);
  const shuffled = [...sessions].sort(() => random() - 0.5);
  const testCount = Math.max(1, Math.round(sessions.length * TEST_FRAC));
  const testSessions = new Set(shuffled.slice(0, testCount));
  const train = rows.filter((r) => !testSessions.has(r.session));
  const test = rows.filter((r) => testSessions.has(r.session));
  if (test.filter((r) => r.result_needed).length < MIN_TEST_POSITIVES) continue;
  if (train.filter((r) => r.result_needed).length < 5) continue;
  iteration += 1;

  const y = test.map((r) => r.result_needed);
  const label = (r: (typeof rows)[number]): number => (r.result_needed ? 1 : 0);

  const w = fit(train.map((r) => base.get(rowKey(r))!), train.map(label));
  plain.push(auc(test.map((r) => sigmoid(dot(base.get(rowKey(r))!, w))), y));

  for (const key of configs) {
    const wa = fit(train.map((r) => augmented(key, rowKey(r))), train.map(label));
    withLaya.get(key)!.push(auc(test.map((r) => sigmoid(dot(augmented(key, rowKey(r)), wa))), y));
  }
}

const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const sd = (v: number[]): number => {
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
};

console.log(`corpus (${from}), laya answers (${scoresFrom}): ${rows.length} calls, ` +
  `${rows.filter((r) => r.result_needed).length} positives, ${sessions.length} sessions`);
console.log(`${iteration} grouped splits, ${Math.round(100 * TEST_FRAC)}% of sessions held out each time`);
console.log(`the 13 features alone: AUC ${mean(plain).toFixed(3)} (sd ${sd(plain).toFixed(3)})\n`);

const header = `${'13 features + laya'.padEnd(34)}${'AUC'.padStart(8)}${'gain'.padStart(8)}` +
  `${'sd'.padStart(8)}${'wins'.padStart(7)}${'verdict'.padStart(9)}`;
console.log(header);
console.log('-'.repeat(header.length));

const ranked = configs
  .map((key) => {
    const runs = withLaya.get(key)!;
    const diffs = runs.map((value, i) => value - plain[i]!);
    return {
      key, auc: mean(runs), gain: mean(diffs), spread: sd(diffs),
      wins: diffs.filter((v) => v > 0).length,
    };
  })
  .sort((a, b) => b.gain - a.gain);

const passes = ranked.filter((r) => r.gain > GATE_GAIN && r.wins >= GATE_WINS * iteration);
for (const row of ranked) {
  const pass = row.gain > GATE_GAIN && row.wins >= GATE_WINS * iteration;
  console.log(
    `${row.key.padEnd(34)}${row.auc.toFixed(3).padStart(8)}` +
    `${`${row.gain >= 0 ? '+' : ''}${row.gain.toFixed(3)}`.padStart(8)}` +
    `${row.spread.toFixed(3).padStart(8)}${`${row.wins}/${iteration}`.padStart(7)}` +
    `${(pass ? 'PASS' : '-').padStart(9)}`,
  );
}

const best = ranked[0]!;
console.log(`\nGate A: gain > +${GATE_GAIN.toFixed(3)} and at least ` +
  `${Math.ceil(GATE_WINS * iteration)} of ${iteration} splits won.`);
console.log(passes.length > 0
  ? `  PASSED on ${passes.length} configuration(s); best is ${best.key} ` +
    `at ${best.gain >= 0 ? '+' : ''}${best.gain.toFixed(3)}.\n` +
    '  -> Laya carries signal the features do not. Distilling it is worth the fine-tune.'
  : `  FAILED. Best is ${best.key} at ${best.gain >= 0 ? '+' : ''}${best.gain.toFixed(3)} ` +
    `over ${best.wins}/${iteration} splits.\n` +
    '  -> Laya adds nothing the same state already gives the features. It is a slower\n' +
    '     way to compute what src/features.ts computes, and that is the finding.');
