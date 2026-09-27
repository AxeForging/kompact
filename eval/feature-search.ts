/**
 * Study 12 — can better features close the gap to the offline optimum?
 *
 * `eval/offline-optimal.ts` showed real headroom between what the scorer frees
 * and what an oracle that knows the future could. The honest lever, given a
 * neural sidecar already lost to this logistic (see `src/features.ts`), is the
 * feature vector — not a heavier model. So this measures, on the same 2239-call
 * leave-one-session-out corpus the scorer is fitted on, whether any richer
 * feature set beats the shipped thirteen.
 *
 * What is fair game: facts known when the state is built — output size, whether
 * the call errored, the tool. What is NOT: `result_needed` (the label),
 * `first_reuse_index`, `match_shingles`, `sampled_shingles`, `result_index` —
 * all of those are the future or derived from it, and `target` is scrubbed out
 * of the committed fixture anyway. The shipped scorer buckets size into three
 * because a *model* cannot read digits; a logistic can, so the obvious candidate
 * is continuous log-size, which the coarse buckets throw away (p50 363 chars,
 * p99 30k — a long tail three buckets cannot see).
 *
 * Continuous columns are standardised with train-fold statistics only, so a fold
 * never sees its own test rows' mean. Run: bun eval/feature-search.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus } from './corpus.js';
import { featureVector } from '../src/features.js';
import { dot, fitLogistic, sigmoid } from './logistic.js';
import { auc, ece } from './metrics.js';
import type { LabelRow } from './extract-labels.js';

type Row = LabelRow;
const log1p = (n: number) => Math.log(1 + Math.max(0, n));

/** A named feature builder plus which of its columns are continuous (to standardise). */
interface FeatureSet {
  name: string;
  build: (r: Row) => number[];
  continuous: number[]; // column indices to standardise per fold
}

const shipped = (r: Row) => featureVector(r.state, r.tool, r.is_error);

const SETS: FeatureSet[] = [
  { name: 'shipped-13', build: shipped, continuous: [] },
  // Sanity floor: bias + one continuous log-size column only.
  { name: 'size-only (log chars)', build: (r) => [1, log1p(r.output_chars)], continuous: [1] },
  // The main hypothesis: keep everything, add continuous log-size.
  { name: 'shipped + log chars', build: (r) => [...shipped(r), log1p(r.output_chars)], continuous: [13] },
  // Does size want a curve, not a line?
  {
    name: 'shipped + log chars + sq',
    build: (r) => { const l = log1p(r.output_chars); return [...shipped(r), l, l * l]; },
    continuous: [13, 14],
  },
  // Add the tools the shipped four-way grouping drops to the reference level.
  {
    name: 'shipped + log chars + tools',
    build: (r) => [
      ...shipped(r),
      log1p(r.output_chars),
      r.tool === 'Agent' ? 1 : 0,
      r.tool === 'WebFetch' || r.tool === 'WebSearch' ? 1 : 0,
      r.tool.startsWith('mcp__') ? 1 : 0,
    ],
    continuous: [13],
  },
];

function standardise(
  xs: number[][],
  trainIdx: number[],
  cols: number[],
): number[][] {
  if (cols.length === 0) return xs;
  const stats = cols.map((c) => {
    const vals = trainIdx.map((i) => xs[i]![c]!);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return { c, mean, sd: Math.sqrt(varr) || 1 };
  });
  return xs.map((row) => {
    const copy = row.slice();
    for (const { c, mean, sd } of stats) copy[c] = (row[c]! - mean) / sd;
    return copy;
  });
}

/** LOSO with per-fold standardisation of the named continuous columns. */
function loso(rows: Row[], set: FeatureSet, target: (r: Row) => boolean) {
  const sessions = [...new Set(rows.map((r) => r.session))];
  const rawX = rows.map(set.build);
  const y = rows.map((r) => (target(r) ? 1 : 0));
  const oof = new Array<number>(rows.length).fill(0.5);
  for (const held of sessions) {
    const trainIdx = rows.map((_, i) => i).filter((i) => rows[i]!.session !== held);
    const testIdx = rows.map((_, i) => i).filter((i) => rows[i]!.session === held);
    if (!trainIdx.length || !testIdx.length) continue;
    const x = standardise(rawX, trainIdx, set.continuous);
    // 6k steps, not the shipped 20k: this is a comparative ranking, and AUC
    // ordering across feature sets is stable long before the last digit of a
    // coefficient settles. Keeps 410 fits under a minute.
    const w = fitLogistic(trainIdx.map((i) => x[i]!), trainIdx.map((i) => y[i]!), { steps: 6000 });
    for (const i of testIdx) oof[i] = sigmoid(dot(x[i]!, w));
  }
  const labels = y.map(Boolean);
  return { auc: auc(oof, labels), ece: ece(oof, labels) };
}

interface SetResult { name: string; resultAuc: number; resultEce: number; callAuc: number; callEce: number }

function main() {
  const { rows, from } = loadCorpus(import.meta.dirname, {
    fixtureOnly: process.argv.includes('--fixture'),
  });
  const sessions = new Set(rows.map((r) => r.session)).size;
  console.log(`corpus (${from}): ${rows.length} calls, ${sessions} sessions\n`);
  const results: SetResult[] = SETS.map((set) => {
    const r = loso(rows, set, (row) => row.result_needed);
    const c = loso(rows, set, (row) => row.call_needed);
    return { name: set.name, resultAuc: r.auc, resultEce: r.ece, callAuc: c.auc, callEce: c.ece };
  });
  const base = results[0]!; // shipped-13 is first
  for (const [head, aucKey, eceKey] of [
    ['result_needed', 'resultAuc', 'resultEce'],
    ['call_needed', 'callAuc', 'callEce'],
  ] as const) {
    console.log(`# ${head}`);
    console.log('feature set'.padEnd(30), 'LOSO AUC', ' ΔAUC', '  ECE');
    for (const row of results) {
      const a = row[aucKey];
      const d = a - base[aucKey];
      const dstr = row.name === 'shipped-13' ? '   —  ' : (d >= 0 ? '+' : '') + d.toFixed(3);
      console.log(row.name.padEnd(30), a.toFixed(3).padStart(7), dstr.padStart(6), row[eceKey].toFixed(3).padStart(6));
    }
    console.log();
  }
  const fixture = {
    calls: rows.length,
    sessions,
    neededPct: Number((100 * rows.filter((r) => r.result_needed).length / rows.length).toFixed(0)),
    best: 'shipped + log chars',
    sets: results.map((r) => ({
      name: r.name,
      resultAuc: Number(r.resultAuc.toFixed(3)),
      resultEce: Number(r.resultEce.toFixed(3)),
      callAuc: Number(r.callAuc.toFixed(3)),
      callEce: Number(r.callEce.toFixed(3)),
    })),
  };
  if (process.argv.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'feature-search.json'), JSON.stringify(fixture, null, 2) + '\n');
    console.log('wrote fixtures/feature-search.json');
  }
  return base;
}

if (import.meta.main) {
  const base = main();
  // Self-check: the shipped-13 result_needed AUC must land near the value
  // src/features.ts documents (0.789 LOSO), or the corpus/plumbing drifted.
  console.assert(
    Math.abs(base.resultAuc - 0.789) < 0.03,
    `shipped-13 result_needed AUC ${base.resultAuc} strayed from documented 0.789`,
  );
}

export { loso, SETS };
