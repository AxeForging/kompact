/**
 * Study 13 — cost-aware eviction: keep small outputs cheaply, drop only the big
 * uncertain ones. Measured on REALIZED retention (no oracle), plus scoring speed.
 *
 * Study 12's lesson: the objective (freed characters) is size-weighted, so the
 * DECISION should be size-aware even when the score is not. The realistic test is
 * two keep-policies over the shipped scorer's out-of-fold P(needed), swept over
 * the keep threshold, each read on the TRUE labels (realized retention, realized
 * freed — not an oracle budget):
 *   P-policy:     keep iff P >= t
 *   cost-aware:   keep iff P >= t  OR  output_chars <= smallCap   (protect cheap outputs)
 * If cost-aware's freed-vs-retention frontier dominates, dropping only big
 * uncertain outputs is a real, model-free lever. Speed is reported too: the whole
 * point of kompact is staying well under the 500ms budget.
 *
 * Reproducible: committed fixture, no model, no network. Run: bun eval/cost-aware.ts [--write]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureVector, score, KEEP_RESULT_WEIGHTS } from '../src/features.js';
import { outOfFold } from './logistic.js';
import { loadCorpus } from './corpus.js';
import { MUTATING, UNREPEATABLE } from '../src/state.js';

/** Realized freed and retention for a keep predicate, on the true labels. */
function realize(keep: (i: number) => boolean, needed: boolean[], chars: number[], forced: boolean[]) {
  const totalNeeded = needed.filter(Boolean).length || 1;
  const total = chars.reduce((a, b) => a + b, 0) || 1;
  let keptNeeded = 0, freed = 0;
  for (let i = 0; i < needed.length; i += 1) {
    const kept = forced[i] || keep(i);
    if (needed[i] && kept) keptNeeded += 1;
    if (!kept) freed += chars[i]!;
  }
  return { retention: keptNeeded / totalNeeded, freed: freed / total };
}

/** Freed at the highest threshold whose realized retention still clears `floor`. */
function freedAtRetention(
  pol: (i: number, t: number) => boolean, thresholds: number[], floor: number,
  needed: boolean[], chars: number[], forced: boolean[],
): number {
  let best = 0;
  for (const t of thresholds) {
    const r = realize((i) => pol(i, t), needed, chars, forced);
    if (r.retention >= floor && r.freed > best) best = r.freed;
  }
  return Number((100 * best).toFixed(1));
}

function main() {
  const args = process.argv.slice(2);
  const { rows, from } = loadCorpus(import.meta.dirname, { fixtureOnly: args.includes('--fixture') });
  const needed = rows.map((r) => r.result_needed);
  const chars = rows.map((r) => r.output_chars);
  const forced = rows.map((r) => MUTATING.has(r.tool) || UNREPEATABLE.has(r.tool));
  const X = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
  const p = outOfFold(rows.map((r) => ({ session: r.session })), X, needed.map((b) => (b ? 1 : 0)));
  const smallCap = [...chars].sort((a, b) => a - b)[Math.floor(chars.length / 2)]!; // median size

  // --- speed: time the shipped scorer over the whole corpus (data, not assertion) ---
  const reps = 20; let ms = 0;
  for (let r = 0; r < reps; r += 1) {
    const t0 = performance.now();
    for (let i = 0; i < rows.length; i += 1) score(KEEP_RESULT_WEIGHTS, featureVector(rows[i]!.state, rows[i]!.tool, rows[i]!.is_error));
    ms += performance.now() - t0;
  }
  const perCorpus = ms / reps;

  const thresholds = Array.from({ length: 101 }, (_, k) => k / 100);
  const pPol = (i: number, t: number) => p[i]! >= t;
  const cPol = (i: number, t: number) => p[i]! >= t || chars[i]! <= smallCap;

  console.log(`corpus (${from}): ${rows.length} calls, ${new Set(rows.map((r) => r.session)).size} sessions`);
  console.log(`scoring speed: ${perCorpus.toFixed(1)} ms for ${rows.length} calls (${(1000 * perCorpus / rows.length).toFixed(1)} us/call), budget 500 ms\n`);
  console.log(`cost-aware smallCap = ${smallCap} chars (corpus median)\n`);
  console.log('retention floor   freed P-policy   freed cost-aware   delta');
  const curve: { floor: number; p: number; c: number }[] = [];
  for (const floor of [0.95, 0.9, 0.85, 0.8]) {
    const fp = freedAtRetention(pPol, thresholds, floor, needed, chars, forced);
    const fc = freedAtRetention(cPol, thresholds, floor, needed, chars, forced);
    curve.push({ floor, p: fp, c: fc });
    console.log(`${(100 * floor).toFixed(0).padStart(13)}%   ${fp.toFixed(1).padStart(11)}%   ${fc.toFixed(1).padStart(15)}%   ${(fc - fp >= 0 ? '+' : '')}${(fc - fp).toFixed(1)}`);
  }
  const at85 = curve.find((c) => c.floor === 0.85)!;
  const verdict = at85.c - at85.p > 2
    ? `HELPS: cost-aware frees +${(at85.c - at85.p).toFixed(1)} pts at 85% realized retention, model-free and within budget.`
    : `NO GAIN: cost-aware within ${(at85.c - at85.p).toFixed(1)} pts of the plain threshold at 85% realized retention.`;
  console.log(`\nverdict: ${verdict}`);
  if (args.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'cost-aware.json'),
      JSON.stringify({ calls: rows.length, smallCap, scoreMsPerCorpus: Number(perCorpus.toFixed(1)), curve, verdict }, null, 2) + '\n');
    console.log('wrote fixtures/cost-aware.json');
  }
  return { curve, perCorpus };
}

if (import.meta.main) {
  const { curve, perCorpus } = main();
  console.assert(perCorpus < 500, `scoring must stay under 500ms, took ${perCorpus}`);
  console.assert(curve.every((c) => c.p >= 0 && c.c >= 0), 'freed shares must be non-negative');
}
