/**
 * Fits the shipped scorer and prints a TypeScript coefficient block.
 *
 * Both targets are fitted: whether the call still matters, and whether its
 * output was needed verbatim. Honest generalisation numbers come from
 * leave-one-session-out; the shipped coefficients are refitted on everything.
 *
 * Run: bun eval/fit.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dot, fitLogistic as fit, sigmoid } from './logistic.js';
import { auc, ece } from './metrics.js';
import { loadCorpus } from './corpus.js';
import { FEATURE_NAMES, featureVector } from '../src/features.js';
import type { LabelRow } from './extract-labels.js';

// `--fixture` forces the committed corpus, so a clone and this machine can be
// shown to agree rather than assumed to.
// `--paired` restricts to the rows every Laya config was scored against — the
// corpus the 0.905 chart is built on — so the page can compare the two
// leave-one-session-out figures instead of carrying one of them as prose.
const { rows, from } = loadCorpus(import.meta.dirname, {
  fixtureOnly: process.argv.includes('--fixture'),
  paired: process.argv.includes('--paired'),
});
console.log(`corpus (${from}): ${rows.length} calls, ${new Set(rows.map((r) => r.session)).size} sessions\n`);



const sessions = [...new Set(rows.map((r) => r.session))];
const x = rows.map((r) => featureVector(r.state, r.tool, r.is_error));

function evaluate(target: (r: LabelRow) => boolean, name: string): number[] {
  const y = rows.map((r) => (target(r) ? 1 : 0));
  const oof = new Array<number>(rows.length).fill(0.5);
  for (const held of sessions) {
    const trainIdx = rows.map((r, i) => [r, i] as const).filter(([r]) => r.session !== held).map(([, i]) => i);
    const testIdx = rows.map((r, i) => [r, i] as const).filter(([r]) => r.session === held).map(([, i]) => i);
    if (trainIdx.length === 0 || testIdx.length === 0) continue;
    const w = fit(trainIdx.map((i) => x[i]!), trainIdx.map((i) => y[i]!));
    for (const i of testIdx) oof[i] = sigmoid(dot(x[i]!, w));
  }
  const labels = y.map(Boolean);
  console.log(`${name}: LOSO AUC ${auc(oof, labels).toFixed(3)}  ECE ${ece(oof, labels).toFixed(3)}  positives ${y.reduce<number>((a, b) => a + b, 0)}/${y.length}`);
  return fit(x, y);
}

const wResult = evaluate((r) => r.result_needed, 'result_needed');
const wCall = evaluate((r) => r.call_needed, 'call_needed  ');

const block = (w: number[]): string =>
  '[\n' + w.map((v, j) => `  ${v.toFixed(6)},${' '.repeat(Math.max(1, 12 - v.toFixed(6).length))}// ${FEATURE_NAMES[j]}`).join('\n') + '\n]';
console.log(`\nexport const KEEP_RESULT_WEIGHTS: readonly number[] = ${block(wResult)};`);
console.log(`\nexport const KEEP_CALL_WEIGHTS: readonly number[] = ${block(wCall)};`);
