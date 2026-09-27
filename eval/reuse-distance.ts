/**
 * Study 9 — how far back is a tool output when it is reused? (placement / recency)
 *
 * "Lost in the middle" work (arXiv 2609.08574) says where a fact sits in the window
 * governs whether it is used. For kompact the actionable version is simpler and
 * measurable retrospectively: when an output IS needed verbatim later, how many
 * messages separate its production from that first reuse? If reuses are mostly
 * short-range, kompact's preserve-recent window already protects the ones that
 * matter and dropping old outputs is safe; if many are long-range, dropping old
 * outputs is where the risk lives. Also: does an output's position in the window
 * predict reuse at all (is recency a real signal)?
 *
 * Descriptive, from extract-labels' own labels (`result_needed`, `result_index`,
 * `first_reuse_index`). It does NOT prove a causal placement effect — that needs a
 * live A/B (Study 10). It bounds where kompact should and should not cut.
 *
 * Run: bun eval/reuse-distance.ts [--write] [--self-check]
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { labelSession } from './extract-labels.js';
import { auc } from './metrics.js';

const args = process.argv.slice(2);
const PRESERVE_RECENT = 6; // kompact's default preserveRecentMessages

function walk(root: string): string[] {
  const out: string[] = []; let e: string[] = [];
  try { e = readdirSync(root); } catch { return out; }
  for (const x of e) { const p = join(root, x); try { const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p)); else if (p.endsWith('.jsonl')) out.push(p);
  } catch { /* */ } }
  return out;
}
const median = (xs: number[]): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export function distances(labels: { result_needed: boolean; result_index: number; first_reuse_index: number }[]) {
  const out: number[] = [];
  for (const r of labels) {
    if (r.result_needed && r.first_reuse_index >= 0 && r.result_index >= 0 && r.first_reuse_index > r.result_index) {
      out.push(r.first_reuse_index - r.result_index);
    }
  }
  return out;
}

function main() {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) { console.log('no corpus'); return; }
  const today = new Date().toISOString().slice(0, 10);
  const dists: number[] = [];
  const posScores: number[] = []; const posLabels: boolean[] = [];
  for (const path of walk(root)) {
    let labels;
    try { labels = labelSession(path, path.split('/').pop()!.slice(0, 8), today); } catch { continue; }
    if (labels.length < 3) continue;
    dists.push(...distances(labels));
    const total = labels[0]?.messages ?? 0;
    if (total > 0) for (const r of labels) {
      // recency of the output = how late it sits (1.0 = newest). Predict result_needed.
      posScores.push(r.result_index / total);
      posLabels.push(r.result_needed);
    }
  }
  const withinPreserve = dists.filter((d) => d <= PRESERVE_RECENT).length;
  const long = dists.filter((d) => d > 50).length;
  const fixture = {
    reuses: dists.length,
    medianDistanceMsgs: Math.round(median(dists)),
    withinPreserveWindowPct: dists.length ? Number((100 * withinPreserve / dists.length).toFixed(1)) : 0,
    longRangePct: dists.length ? Number((100 * long / dists.length).toFixed(1)) : 0,
    recencyPredictsReuseAuc: Number(auc(posScores, posLabels).toFixed(3)),
  };
  console.log(`\nreuses measured: ${fixture.reuses}`);
  console.log(`distance production -> first reuse (messages): median ${fixture.medianDistanceMsgs}`);
  console.log(`  within kompact's preserve-recent window (<=${PRESERVE_RECENT}): ${fixture.withinPreserveWindowPct}%`);
  console.log(`  long-range (>50 messages): ${fixture.longRangePct}%`);
  console.log(`recency (position) predicts reuse: AUC ${fixture.recencyPredictsReuseAuc}  (0.5 = no signal)`);
  console.log(`\ntakeaway: ${fixture.longRangePct >= 25
    ? `${fixture.longRangePct}% of reuses are long-range (>50 msgs back) — dropping old outputs IS where kompact's risk lives; the archive (Study 8) or a high keep-bar for old-but-referenced outputs matters.`
    : `most reuses are near-range (median ${fixture.medianDistanceMsgs} msgs; only ${fixture.longRangePct}% long-range), so kompact's preserve-recent window catches much of what matters and dropping genuinely-old outputs is comparatively safe.`}`);
  console.log(`(Descriptive: this says where reuse happens, not that placement causes it. Causation needs a live A/B.)`);

  if (args.includes('--write')) {
    const out = join(import.meta.dirname, 'fixtures', 'reuse-distance.json');
    writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`\nwrote ${out}`);
  }
}

/** ponytail: self-check the distance extraction. */
function selfCheck() {
  const d = distances([
    { result_needed: true, result_index: 10, first_reuse_index: 14 },  // dist 4
    { result_needed: true, result_index: 2, first_reuse_index: 90 },   // dist 88
    { result_needed: false, result_index: 5, first_reuse_index: 8 },   // not needed -> skip
    { result_needed: true, result_index: 20, first_reuse_index: -1 },  // no reuse -> skip
  ]);
  if (d.length !== 2 || d[0] !== 4 || d[1] !== 88) throw new Error(`distances wrong: ${JSON.stringify(d)}`);
}

selfCheck();
if (args.includes('--self-check')) console.log('self-check ok');
else main();
