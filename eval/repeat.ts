/**
 * Repeated evaluation, because one number is not a measurement.
 *
 * The headline AUC came from a single leave-one-session-out pass. That gives no
 * error bars, and Laya's own best config already moved from 0.694 to 0.664 when
 * the corpus grew — evidence that a single split on a small sample flatters
 * whatever it measures. So: N independent grouped splits, resampling at the
 * SESSION level because calls inside one session are correlated and splitting on
 * rows would leak.
 *
 * Every scorer is judged on the same test split each iteration, so the
 * comparison is paired and the difference is what carries the signal.
 *
 * Run: bun eval/repeat.ts [--iterations 10] [--test-frac 0.3]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { auc, droppableAt } from './score.js';
import { FEATURE_NAMES, featureVector } from '../src/features.js';
import type { LabelRow } from './extract-labels.js';

const dir = import.meta.dirname;
const args = process.argv.slice(2);
const num = (flag: string, fallback: number): number => {
  const index = args.indexOf(flag);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const ITERATIONS = num('--iterations', 10);
const TEST_FRAC = num('--test-frac', 0.3);
/** A split with too few positives cannot produce a meaningful AUC. */
const MIN_TEST_POSITIVES = 5;

const rows: LabelRow[] = readFileSync(join(dir, 'labels.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LabelRow);

const sessions = [...new Set(rows.map((r) => r.session))];
const x = new Map(rows.map((r) => [r.tool_use_id, featureVector(r.state, r.tool, r.is_error)]));

/** Deterministic PRNG, so a reported run can be re-run exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((s, v, j) => s + v * (b[j] ?? 0), 0);

function fit(xs: number[][], ys: number[], steps = 6_000, lr = 0.5, l2 = 1e-3): number[] {
  const d = xs[0]!.length;
  const w = new Array<number>(d).fill(0);
  for (let step = 0; step < steps; step += 1) {
    const g = new Array<number>(d).fill(0);
    for (let i = 0; i < xs.length; i += 1) {
      const e = sigmoid(dot(xs[i]!, w)) - ys[i]!;
      for (let j = 0; j < d; j += 1) g[j]! += (e * xs[i]![j]!) / xs.length;
    }
    for (let j = 1; j < d; j += 1) g[j]! += l2 * w[j]!;
    for (let j = 0; j < d; j += 1) w[j]! -= lr * g[j]!;
  }
  return w;
}

const cache: Record<string, Record<string, { result: number }>> = existsSync(join(dir, 'scores.json'))
  ? JSON.parse(readFileSync(join(dir, 'scores.json'), 'utf8'))
  : {};
const layaConfigs = Object.keys(cache)
  .filter((key) => rows.filter((r) => cache[key]![r.tool_use_id]).length >= rows.length * 0.95)
  .sort();

interface Run { auc: number; drop90: number }
const results = new Map<string, Run[]>();
const record = (name: string, run: Run): void => {
  const list = results.get(name) ?? [];
  list.push(run);
  results.set(name, list);
};

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
  const testPositives = test.filter((r) => r.result_needed).length;
  if (testPositives < MIN_TEST_POSITIVES || train.filter((r) => r.result_needed).length < 5) continue;
  iteration += 1;

  const y = test.map((r) => r.result_needed);
  const chars = test.map((r) => r.output_chars);
  const scoreRun = (scores: number[]): Run => {
    const at90 = droppableAt(scores, y, chars, 0.9);
    return { auc: auc(scores, y), drop90: (100 * at90.droppedChars) / Math.max(1, at90.totalChars) };
  };

  const w = fit(train.map((r) => x.get(r.tool_use_id)!), train.map((r) => (r.result_needed ? 1 : 0)));
  record('logistic (features)', scoreRun(test.map((r) => sigmoid(dot(x.get(r.tool_use_id)!, w)))));
  record('output size only', scoreRun(test.map((r) => Math.min(1, r.output_chars / 50_000))));
  for (const key of layaConfigs) {
    record(`laya ${key}`, scoreRun(test.map((r) => cache[key]![r.tool_use_id]?.result ?? 0.5)));
  }
}

function stats(values: number[]): { mean: number; sd: number; lo: number; hi: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length - 1));
  const sorted = [...values].sort((a, b) => a - b);
  return { mean, sd, lo: sorted[0]!, hi: sorted[sorted.length - 1]! };
}

console.log(`corpus: ${rows.length} calls, ${rows.filter((r) => r.result_needed).length} positives, ${sessions.length} sessions`);
console.log(`${iteration} grouped splits, ${Math.round(100 * TEST_FRAC)}% of sessions held out each time\n`);

const header = `${'scorer'.padEnd(34)}${'AUC mean'.padStart(9)}${'sd'.padStart(7)}${'min'.padStart(7)}${'max'.padStart(7)}${'drop@90%'.padStart(10)}`;
console.log(header);
console.log('-'.repeat(header.length));
const ranked = [...results.entries()]
  .map(([name, runs]) => ({ name, a: stats(runs.map((r) => r.auc)), d: stats(runs.map((r) => r.drop90)) }))
  .sort((p, q) => q.a.mean - p.a.mean);
for (const { name, a, d } of ranked) {
  console.log(
    `${name.padEnd(34)}${a.mean.toFixed(3).padStart(9)}${a.sd.toFixed(3).padStart(7)}` +
    `${a.lo.toFixed(3).padStart(7)}${a.hi.toFixed(3).padStart(7)}${d.mean.toFixed(1).padStart(9)}%`,
  );
}

// The paired question: does the free model beat the best model on the SAME split
// every time, or only on average? A win rate below 10/10 means it is not settled.
const logistic = results.get('logistic (features)')!;
const bestLaya = layaConfigs
  .map((key) => ({ key, runs: results.get(`laya ${key}`)! }))
  .sort((p, q) => stats(q.runs.map((r) => r.auc)).mean - stats(p.runs.map((r) => r.auc)).mean)[0];
if (bestLaya) {
  const diffs = logistic.map((run, i) => run.auc - bestLaya.runs[i]!.auc);
  const d = stats(diffs);
  const wins = diffs.filter((v) => v > 0).length;
  console.log(`\npaired vs best laya (${bestLaya.key}):`);
  console.log(`  logistic - laya AUC: mean ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(3)} (sd ${d.sd.toFixed(3)}, range ${d.lo.toFixed(3)} to ${d.hi.toFixed(3)})`);
  console.log(`  logistic won ${wins}/${diffs.length} splits`);
  console.log(wins === diffs.length
    ? '  -> the free scorer wins on every split; the sidecar is not justified for this task.'
    : `  -> NOT settled: laya won ${diffs.length - wins} split(s). Report the range, not the mean.`);
}
console.log(`\nfeatures: ${FEATURE_NAMES.length} (${FEATURE_NAMES.slice(1, 4).join(', ')}, ...)`);
