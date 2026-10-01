/**
 * Study 22 — does a content feature carry signal the 13 structural ones don't?
 *
 * The scorer's features are all structural (tool, size, recency, isError, target
 * touched again) — the strip plot is coarse because twelve are boolean. Study 12
 * found a richer STRUCTURAL feature (log size) lifted AUC but regressed
 * freed@retention, and Study 11 put the scorer near its ceiling. The one class
 * never tried is CONTENT. This computes a cheap, local lexical-novelty feature —
 * the fraction of a call's state tokens not seen in earlier calls of the same
 * session — and asks the only question that justifies a refit: does it rank needed
 * outputs on its own, and is that signal INDEPENDENT of the shipped score, or just
 * a restatement of size/age? No model, no network.
 *
 * Reproducible: committed fixture, shipped weights, no model. Run: bun eval/content-feature.ts [--fixture] [--write]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureVector, score, KEEP_RESULT_WEIGHTS } from '../src/features.js';
import { loadCorpus } from './corpus.js';

/** Mann–Whitney AUC: P(positive ranks above negative), ties at 0.5. */
function auc(values: number[], labels: boolean[]): number {
  const order = values.map((v, i) => i).sort((a, b) => values[a]! - values[b]!);
  let rankSum = 0, pos = 0, i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length && values[order[j]!]! === values[order[i]!]!) j += 1;
    const avgRank = (i + j + 1) / 2; // 1-based average rank over the tie block
    for (let k = i; k < j; k += 1) if (labels[order[k]!]) { rankSum += avgRank; pos += 1; }
    i = j;
  }
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

function pearson(a: number[], b: number[]): number {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) { const x = a[i]! - ma, y = b[i]! - mb; num += x * y; da += x * x; db += y * y; }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

function main() {
  const args = process.argv.slice(2);
  const { rows, from } = loadCorpus(import.meta.dirname, { fixtureOnly: args.includes('--fixture') });

  // Lexical novelty per call: fraction of its state tokens not seen in earlier
  // calls of the same session (ordered by result_index). A running vocabulary per
  // session, filled in order.
  const seen = new Map<string, Set<string>>();
  const order = rows.map((_, i) => i).sort((a, b) =>
    rows[a]!.session === rows[b]!.session
      ? rows[a]!.result_index - rows[b]!.result_index
      : rows[a]!.session.localeCompare(rows[b]!.session));
  const novelty = new Array<number>(rows.length).fill(0);
  for (const i of order) {
    const vocab = seen.get(rows[i]!.session) ?? new Set<string>();
    const uniq = new Set(tokens(rows[i]!.state));
    let fresh = 0;
    for (const t of uniq) if (!vocab.has(t)) fresh += 1;
    novelty[i] = uniq.size ? fresh / uniq.size : 0;
    for (const t of uniq) vocab.add(t);
    seen.set(rows[i]!.session, vocab);
  }

  const labels = rows.map((r) => r.result_needed);
  const scores = rows.map((_, i) =>
    score(KEEP_RESULT_WEIGHTS, featureVector(rows[i]!.state, rows[i]!.tool, rows[i]!.is_error)));
  const noveltyAuc = auc(novelty, labels);
  const scoreAuc = auc(scores, labels);
  const corr = pearson(novelty, scores);

  console.log(`corpus (${from}): ${rows.length} calls, ${labels.filter(Boolean).length} needed\n`);
  console.log(`shipped score AUC (reference):  ${scoreAuc.toFixed(3)}`);
  console.log(`lexical-novelty AUC:            ${noveltyAuc.toFixed(3)}  (0.50 = no ranking signal)`);
  console.log(`novelty vs score correlation:   ${corr.toFixed(3)}  (±1 = redundant with the current features)`);

  const lift = Math.abs(noveltyAuc - 0.5);
  const independent = lift >= 0.03 && Math.abs(corr) < 0.5;
  const verdict = independent
    ? `WORTH A REFIT: lexical novelty ranks needed outputs on its own (AUC ${noveltyAuc.toFixed(3)}, |Δ|=${lift.toFixed(3)}) and is `
      + `only weakly correlated with the shipped score (${corr.toFixed(2)}), so it carries content signal the structural `
      + `features miss. Next: refit with it and judge on freed@retention (Study 12's lesson — AUC lift is necessary, not sufficient).`
    : `CONFIRMS THE CEILING: lexical novelty ${lift < 0.03 ? `barely ranks needed outputs (AUC ${noveltyAuc.toFixed(3)})` : `is redundant with the current features (corr ${corr.toFixed(2)})`}, `
      + `so it adds nothing a refit could use. The remaining lever stays a second operator's data (Study 16), not a new feature — content included.`;
  console.log(`\nverdict: ${verdict}`);

  const fixture = {
    calls: rows.length, needed: labels.filter(Boolean).length,
    scoreAuc: Number(scoreAuc.toFixed(3)), noveltyAuc: Number(noveltyAuc.toFixed(3)),
    correlation: Number(corr.toFixed(3)), verdict,
  };
  if (args.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'content-feature.json'),
      JSON.stringify(fixture, null, 2) + '\n');
    console.log('\nwrote fixtures/content-feature.json');
  }
  return { noveltyAuc, scoreAuc, corr };
}

if (import.meta.main) {
  const { noveltyAuc, scoreAuc } = main();
  // The novelty feature and the reference AUC are genuine probabilities, and the
  // shipped scorer must out-rank chance on its own corpus or the reference is wrong.
  console.assert(noveltyAuc >= 0 && noveltyAuc <= 1, 'novelty AUC out of range');
  console.assert(scoreAuc > 0.6, `the shipped score should rank needed outputs well above chance (was ${scoreAuc.toFixed(3)})`);
}
