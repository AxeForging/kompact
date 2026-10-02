/**
 * Study 24 — does the content (novelty) feature help freed@retention after a refit?
 *
 * Study 22 found lexical novelty ranks needed outputs on its own (AUC 0.707) and is
 * only partly redundant with the shipped score. That is the cheap screen; Study 12's
 * hard lesson is that an AUC lift can still REGRESS the real objective. So this is
 * the decision: refit both heads (result/call) leave-one-session-out, with and
 * without the novelty feature, run the REAL `decideAll` on the out-of-fold scores,
 * and compare freed@retention. Implement only if +novelty Pareto-beats shipped.
 *
 * Reproducible: committed fixture, no model. Run: bun eval/content-refit.ts [--fixture] [--write]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus } from './corpus.js';
import { featureVector } from '../src/features.js';
import { dot, fitLogistic, sigmoid } from './logistic.js';
import { auc } from './metrics.js';
import { decideAll, DEFAULT_OPTIONS } from '../src/compact.js';
import type { LabelRow } from './extract-labels.js';
import type { ToolCall, CallAnswer } from '../src/index.js';

const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

// Lexical novelty per call: fraction of its state tokens not seen earlier in the
// session (same definition as Study 22's content-feature.ts).
function noveltyOf(rows: LabelRow[]): number[] {
  const seen = new Map<string, Set<string>>();
  const order = rows.map((_, i) => i).sort((a, b) =>
    rows[a]!.session === rows[b]!.session
      ? rows[a]!.result_index - rows[b]!.result_index
      : rows[a]!.session.localeCompare(rows[b]!.session));
  const out = new Array<number>(rows.length).fill(0);
  for (const i of order) {
    const vocab = seen.get(rows[i]!.session) ?? new Set<string>();
    const uniq = new Set(tokens(rows[i]!.state));
    let fresh = 0;
    for (const t of uniq) if (!vocab.has(t)) fresh += 1;
    out[i] = uniq.size ? fresh / uniq.size : 0;
    for (const t of uniq) vocab.add(t);
    seen.set(rows[i]!.session, vocab);
  }
  return out;
}

function standardise(xs: number[][], trainIdx: number[], cols: number[]): number[][] {
  if (!cols.length) return xs;
  const stats = cols.map((c) => {
    const vals = trainIdx.map((i) => xs[i]![c]!);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    return { c, mean, sd };
  });
  return xs.map((row) => { const r = row.slice(); for (const { c, mean, sd } of stats) r[c] = (row[c]! - mean) / sd; return r; });
}

/** Out-of-fold probabilities for one target, with per-fold standardisation. */
function losoOOF(rows: LabelRow[], rawX: number[][], continuous: number[], target: (r: LabelRow) => boolean): number[] {
  const sessions = [...new Set(rows.map((r) => r.session))];
  const y = rows.map((r) => (target(r) ? 1 : 0));
  const oof = new Array<number>(rows.length).fill(0.5);
  for (const held of sessions) {
    const trainIdx = rows.map((_, i) => i).filter((i) => rows[i]!.session !== held);
    const testIdx = rows.map((_, i) => i).filter((i) => rows[i]!.session === held);
    if (!trainIdx.length || !testIdx.length) continue;
    const x = standardise(rawX, trainIdx, continuous);
    const w = fitLogistic(trainIdx.map((i) => x[i]!), trainIdx.map((i) => y[i]!), { steps: 6000 });
    for (const i of testIdx) oof[i] = sigmoid(dot(x[i]!, w));
  }
  return oof;
}

function freedAtRetention(rows: LabelRow[], keepResult: number[], keepCall: number[]) {
  const bySession = new Map<string, number[]>();
  rows.forEach((r, i) => { const l = bySession.get(r.session) ?? []; l.push(i); bySession.set(r.session, l); });
  let needed = 0, kept = 0, freed = 0, total = 0;
  for (const idx of bySession.values()) {
    const calls: ToolCall[] = idx.map((i) => ({
      id: rows[i]!.tool_use_id, tool_use_id: rows[i]!.tool_use_id, tool: rows[i]!.tool, input: {},
      callIndex: 0, resultIndex: 1, resultText: '', resultChars: rows[i]!.output_chars,
      isError: rows[i]!.is_error, pinned: false,
    }));
    const ans = new Map<string, CallAnswer>(idx.map((i) => [rows[i]!.tool_use_id,
      { keepResult: keepResult[i]!, keepCall: keepCall[i]! }]));
    const dropped = new Set(decideAll(calls, ans, DEFAULT_OPTIONS).filter((d) => d.action !== 'keep').map((d) => d.id));
    for (const i of idx) {
      total += rows[i]!.output_chars;
      if (dropped.has(rows[i]!.tool_use_id)) freed += rows[i]!.output_chars;
      if (rows[i]!.result_needed) { needed += 1; if (!dropped.has(rows[i]!.tool_use_id)) kept += 1; }
    }
  }
  return { kept: kept / needed, freed: freed / total };
}

function main() {
  const args = process.argv.slice(2);
  const { rows, from } = loadCorpus(import.meta.dirname, { fixtureOnly: args.includes('--fixture') });
  const novelty = noveltyOf(rows);
  const shipped = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
  const plus = rows.map((f, i) => [...shipped[i]!, novelty[i]!]);

  const t0 = performance.now();
  const evalSet = (rawX: number[][], continuous: number[]) => {
    const kr = losoOOF(rows, rawX, continuous, (r) => r.result_needed);
    const kc = losoOOF(rows, rawX, continuous, (r) => r.call_needed);
    const fr = freedAtRetention(rows, kr, kc);
    return { auc: auc(kr, rows.map((r) => r.result_needed)), ...fr };
  };
  const base = evalSet(shipped, []);
  const withNov = evalSet(plus, [shipped[0]!.length]); // novelty is the last column
  const ms = performance.now() - t0;

  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  console.log(`corpus (${from}): ${rows.length} calls, ${new Set(rows.map((r) => r.session)).size} sessions\n`);
  console.log('feature set         LOSO AUC   kept/needed   freed');
  console.log(`shipped-13          ${base.auc.toFixed(3).padStart(8)}   ${pct(base.kept).padStart(11)}   ${pct(base.freed).padStart(5)}`);
  console.log(`+ lexical novelty   ${withNov.auc.toFixed(3).padStart(8)}   ${pct(withNov.kept).padStart(11)}   ${pct(withNov.freed).padStart(5)}`);

  const dFreed = withNov.freed - base.freed, dKept = withNov.kept - base.kept, dAuc = withNov.auc - base.auc;
  // Implement only if it Pareto-beats shipped: more freed at no retention cost (or
  // vice versa). Study 12: an AUC lift that does not clear this bar is not shipped.
  const pareto = (dFreed > 0.005 && dKept >= -0.005) || (dKept > 0.005 && dFreed >= -0.005);
  const verdict = pareto
    ? `IMPLEMENT: +novelty Pareto-beats shipped — freed ${dFreed >= 0 ? '+' : ''}${pct(dFreed)}, retention ${dKept >= 0 ? '+' : ''}${pct(dKept)} `
      + `(AUC ${dAuc >= 0 ? '+' : ''}${dAuc.toFixed(3)}). Add novelty to src/features.ts, refit the shipped weights, update the site + fact-check.`
    : `DO NOT IMPLEMENT: novelty moves AUC ${dAuc >= 0 ? '+' : ''}${dAuc.toFixed(3)} but freed@retention ${dFreed >= 0 ? '+' : ''}${pct(dFreed)} at `
      + `${dKept >= 0 ? '+' : ''}${pct(dKept)} retention — it does not Pareto-beat the shipped thirteen on the real objective. `
      + `Same shape as Study 12's log-size: an AUC screen is necessary, not sufficient. The content lead is closed.`;
  console.log(`\nspeed: ${(ms / 1000).toFixed(1)} s (refit, not the scoring path)`);
  console.log(`verdict: ${verdict}`);

  const r = (x: number) => Number((100 * x).toFixed(1));
  const fixture = {
    calls: rows.length,
    shipped: { auc: Number(base.auc.toFixed(3)), kept: r(base.kept), freed: r(base.freed) },
    withNovelty: { auc: Number(withNov.auc.toFixed(3)), kept: r(withNov.kept), freed: r(withNov.freed) },
    verdict,
  };
  if (args.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'content-refit.json'), JSON.stringify(fixture, null, 2) + '\n');
    console.log('\nwrote fixtures/content-refit.json');
  }
  return { base, withNov };
}

if (import.meta.main) {
  const { base } = main();
  // The shipped-13 refit here must reproduce the documented LOSO AUC (0.789). Its
  // freed@retention is NOT the shipped 20.7%/85.4%: `base` is a LOSO refit at 6k
  // steps, not the committed 20k-step all-sessions weights, so its operating point
  // differs — only the refit-vs-refit DELTA against +novelty is comparable. Just
  // sanity-check base lands in a plausible range.
  console.assert(Math.abs(base.auc - 0.789) < 0.03, `shipped-13 AUC ${base.auc.toFixed(3)} strayed from 0.789`);
  console.assert(base.kept > 0.7 && base.kept < 0.95 && base.freed > 0.1 && base.freed < 0.35,
    `shipped-13 refit operating point ${base.freed.toFixed(3)}/${base.kept.toFixed(3)} is implausible`);
}
