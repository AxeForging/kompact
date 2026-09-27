/**
 * Study 15 — is the shipped keepThreshold on the freed@retention frontier?
 *
 * kompact ships keepThreshold 0.2. Study 12 taught that the operating metric is
 * freed-at-retention, not AUC — so the threshold itself is a lever worth checking
 * before touching the model at all. This runs the REAL policy (`decideAll`, with
 * its force-keeps, drop_call/drop_result split and truncation) over the corpus at
 * a sweep of thresholds and reports needed-retention and freed characters at each,
 * so the shipped point can be seen against the whole curve.
 *
 * Reproducible: committed fixture, shipped weights, no model. Run: bun eval/operating-point.ts [--write]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureVector, score, KEEP_RESULT_WEIGHTS, KEEP_CALL_WEIGHTS } from '../src/features.js';
import { decideAll, DEFAULT_OPTIONS } from '../src/compact.js';
import { loadCorpus } from './corpus.js';
import type { ToolCall, CallAnswer } from '../src/index.js';

function main() {
  const args = process.argv.slice(2);
  const { rows, from } = loadCorpus(import.meta.dirname, { fixtureOnly: args.includes('--fixture') });
  const feats = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
  const bySession = new Map<string, number[]>();
  rows.forEach((r, i) => { const l = bySession.get(r.session) ?? []; l.push(i); bySession.set(r.session, l); });

  const at = (threshold: number) => {
    let needed = 0, kept = 0, freed = 0, total = 0;
    for (const idx of bySession.values()) {
      const calls: ToolCall[] = idx.map((i) => ({
        id: rows[i]!.tool_use_id, tool_use_id: rows[i]!.tool_use_id, tool: rows[i]!.tool, input: {},
        callIndex: 0, resultIndex: 1, resultText: '', resultChars: rows[i]!.output_chars,
        isError: rows[i]!.is_error, pinned: false,
      }));
      const ans = new Map<string, CallAnswer>(idx.map((i) => [rows[i]!.tool_use_id, {
        keepResult: score(KEEP_RESULT_WEIGHTS, feats[i]!), keepCall: score(KEEP_CALL_WEIGHTS, feats[i]!),
      }]));
      const dropped = new Set(decideAll(calls, ans, { ...DEFAULT_OPTIONS, keepThreshold: threshold })
        .filter((d) => d.action !== 'keep').map((d) => d.id));
      for (const i of idx) {
        total += rows[i]!.output_chars;
        if (dropped.has(rows[i]!.tool_use_id)) freed += rows[i]!.output_chars;
        if (!rows[i]!.result_needed) continue;
        needed += 1; if (!dropped.has(rows[i]!.tool_use_id)) kept += 1;
      }
    }
    return { kept: kept / needed, freed: freed / total };
  };

  console.log(`corpus (${from}): ${rows.length} calls, ${bySession.size} sessions\n`);
  console.log('keepThreshold   kept/needed   freed/total');
  const curve: { thr: number; kept: number; freed: number }[] = [];
  for (const thr of [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
    const r = at(thr);
    curve.push({ thr, kept: Number((100 * r.kept).toFixed(1)), freed: Number((100 * r.freed).toFixed(1)) });
    const mark = thr === DEFAULT_OPTIONS.keepThreshold ? '  <- shipped' : '';
    console.log(`${thr.toFixed(2).padStart(12)}   ${(100 * r.kept).toFixed(1).padStart(9)}%   ${(100 * r.freed).toFixed(1).padStart(9)}%${mark}`);
  }
  // Pareto: is any threshold strictly better than shipped on BOTH axes?
  const shipped = curve.find((c) => c.thr === DEFAULT_OPTIONS.keepThreshold)!;
  const dominators = curve.filter((c) => c.kept >= shipped.kept && c.freed > shipped.freed
    || c.freed >= shipped.freed && c.kept > shipped.kept);
  const verdict = dominators.length === 0
    ? `ON THE FRONTIER: no swept threshold beats the shipped ${shipped.thr} on both retention and freed — the default is Pareto-optimal on this corpus.`
    : `OFF THE FRONTIER: ${dominators.map((d) => d.thr).join(', ')} dominate the shipped ${shipped.thr} (>= on one axis, > on the other). Worth re-tuning.`;
  console.log(`\nverdict: ${verdict}`);
  if (args.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'operating-point.json'),
      JSON.stringify({ calls: rows.length, shipped: shipped.thr, curve, verdict }, null, 2) + '\n');
    console.log('wrote fixtures/operating-point.json');
  }
  return { curve, shipped };
}

if (import.meta.main) {
  const { curve } = main();
  // Self-check: retention is monotonic non-increasing as the threshold rises
  // (a higher bar keeps fewer needed outputs).
  for (let i = 1; i < curve.length; i += 1) {
    console.assert(curve[i]!.kept <= curve[i - 1]!.kept + 0.1,
      `retention must fall as threshold rises: ${curve[i - 1]!.thr}->${curve[i]!.thr}`);
  }
}
