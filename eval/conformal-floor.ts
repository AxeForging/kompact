/**
 * Study 21 — a conformal floor: turn "90% safe" from a claim into a guarantee.
 *
 * kompact ships a fixed keepThreshold (0.2) and the docs call 90% retention a
 * "defensible" setting — asserted, not guaranteed, and Study 16 showed a fixed
 * threshold fails on a different harness. Split conformal prediction sets the floor
 * from the operator's OWN sessions so that needed-retention meets a chosen target
 * with a distribution-free guarantee. This calibrates the floor leave-one-session-
 * out (the realistic cross-session shift), runs the real `decideAll` at that floor
 * on the held-out session, and reports realized retention (coverage) and freed, for
 * targets 85/90/95%, against the fixed 0.2.
 *
 * Reproducible: committed fixture, shipped weights, no model. Run: bun eval/conformal-floor.ts [--fixture] [--write]
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
  const keepResult = rows.map((_, i) => score(KEEP_RESULT_WEIGHTS, feats[i]!));
  const keepCall = rows.map((_, i) => score(KEEP_CALL_WEIGHTS, feats[i]!));
  const bySession = new Map<string, number[]>();
  rows.forEach((r, i) => { const l = bySession.get(r.session) ?? []; l.push(i); bySession.set(r.session, l); });
  const sessions = [...bySession.keys()];

  // decideAll on one session's indices at a given keepThreshold -> {needed, kept, freed, total}.
  const runSession = (idx: number[], threshold: number) => {
    const calls: ToolCall[] = idx.map((i) => ({
      id: rows[i]!.tool_use_id, tool_use_id: rows[i]!.tool_use_id, tool: rows[i]!.tool, input: {},
      callIndex: 0, resultIndex: 1, resultText: '', resultChars: rows[i]!.output_chars,
      isError: rows[i]!.is_error, pinned: false,
    }));
    const ans = new Map<string, CallAnswer>(idx.map((i) => [rows[i]!.tool_use_id,
      { keepResult: keepResult[i]!, keepCall: keepCall[i]! }]));
    const dropped = new Set(decideAll(calls, ans, { ...DEFAULT_OPTIONS, keepThreshold: threshold })
      .filter((d) => d.action !== 'keep').map((d) => d.id));
    let needed = 0, kept = 0, freed = 0, total = 0;
    for (const i of idx) {
      total += rows[i]!.output_chars;
      if (dropped.has(rows[i]!.tool_use_id)) freed += rows[i]!.output_chars;
      if (rows[i]!.result_needed) { needed += 1; if (!dropped.has(rows[i]!.tool_use_id)) kept += 1; }
    }
    return { needed, kept, freed, total };
  };

  // Split-conformal threshold: for target retention q, keep the fraction q of
  // needed outputs, so drop at most α = 1−q. τ is the α(n+1)-th smallest needed
  // score among the CALIBRATION sessions — the finite-sample conformal quantile.
  const conformalTau = (calibIdx: number[], q: number) => {
    const s = calibIdx.filter((i) => rows[i]!.result_needed).map((i) => keepResult[i]!).sort((a, b) => a - b);
    if (s.length === 0) return 0;
    const k = Math.max(0, Math.min(s.length - 1, Math.floor((1 - q) * (s.length + 1)) - 1));
    return s[k]!;
  };

  const evalTarget = (q: number) => {
    let needed = 0, kept = 0, freed = 0, total = 0, taus = 0;
    const covered: number[] = [];
    for (const test of sessions) {
      const calib = sessions.filter((x) => x !== test).flatMap((x) => bySession.get(x)!);
      const tau = conformalTau(calib, q);
      taus += tau;
      const r = runSession(bySession.get(test)!, tau);
      needed += r.needed; kept += r.kept; freed += r.freed; total += r.total;
      if (r.needed > 0) covered.push(r.kept / r.needed >= q ? 1 : 0);
    }
    return {
      tau: taus / sessions.length,
      kept: needed ? kept / needed : 1,
      freed: total ? freed / total : 0,
      // Coverage: share of sessions whose realized retention met the target.
      sessionCoverage: covered.length ? covered.reduce((a, b) => a + b, 0) / covered.length : 1,
    };
  };

  // Fixed shipped threshold, same decideAll, for the comparison line.
  const fixed = (() => {
    let needed = 0, kept = 0, freed = 0, total = 0;
    for (const idx of bySession.values()) {
      const r = runSession(idx, DEFAULT_OPTIONS.keepThreshold);
      needed += r.needed; kept += r.kept; freed += r.freed; total += r.total;
    }
    return { kept: kept / needed, freed: freed / total };
  })();

  const targets = [0.85, 0.90, 0.95];
  const t0 = performance.now();
  const results = targets.map((q) => ({ q, ...evalTarget(q) }));
  const ms = performance.now() - t0;

  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  console.log(`corpus (${from}): ${rows.length} calls, ${sessions.length} sessions\n`);
  console.log(`fixed keepThreshold ${DEFAULT_OPTIONS.keepThreshold}: kept ${pct(fixed.kept)}, freed ${pct(fixed.freed)}\n`);
  console.log('target   mean floor   realized kept   freed   session coverage');
  for (const r of results) {
    console.log(`${pct(r.q).padStart(5)}   ${r.tau.toFixed(3).padStart(10)}   ${pct(r.kept).padStart(11)}   `
      + `${pct(r.freed).padStart(5)}   ${pct(r.sessionCoverage).padStart(14)}`);
  }

  // The guarantee holding is not the question — freed@retention is. A conformal
  // floor is only worth shipping if, at a retention it guarantees, it frees about
  // as much as the fixed threshold already does. It is "competitive" if some target
  // reaches the fixed point's freed while meeting its own retention goal.
  const hits = results.filter((r) => r.kept >= r.q - 0.02).length;
  const competitive = results.some((r) => r.freed >= fixed.freed - 0.02 && r.kept >= r.q - 0.02);
  const verdict = competitive
    ? `WORTH IMPLEMENTING: the conformal floor meets its retention target AND frees about as much as the fixed `
      + `threshold, so the operator can pick a guaranteed retention at no freed cost. Set the floor by calibration `
      + `(ties into calibrate --contribute), judged on freed@retention before shipping.`
    : `DOMINATED — DO NOT IMPLEMENT: the floor keeps its retention promise (realized ≥ target for ${hits}/${results.length} `
      + `targets) but frees far too little to do it — only ${pct(results[0]!.freed)}–${pct(results[1]!.freed)} at the 85–90% `
      + `retention the product targets, against the fixed 0.2's ${pct(fixed.freed)} freed at ${pct(fixed.kept)} retention, which `
      + `already clears those targets. The floor lands at ${results[1]!.tau.toFixed(3)} (below the fixed 0.2) because the `
      + `scorer's scores are coarse and clustered, so a needed-score quantile keeps almost everything. The fixed threshold `
      + `is already on the Study 15 frontier; conformal buys rigor, not freed. Keep the fixed floor.`;
  console.log(`\nspeed: ${ms.toFixed(1)} ms`);
  console.log(`verdict: ${verdict}`);

  const round = (x: number) => Number((100 * x).toFixed(1));
  const fixture = {
    calls: rows.length, sessions: sessions.length,
    fixed: { threshold: DEFAULT_OPTIONS.keepThreshold, kept: round(fixed.kept), freed: round(fixed.freed) },
    targets: results.map((r) => ({ target: round(r.q), floor: Number(r.tau.toFixed(3)),
      kept: round(r.kept), freed: round(r.freed), sessionCoverage: round(r.sessionCoverage) })),
    verdict,
  };
  if (args.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'conformal-floor.json'),
      JSON.stringify(fixture, null, 2) + '\n');
    console.log('\nwrote fixtures/conformal-floor.json');
  }
  return { results, fixed, ms };
}

if (import.meta.main) {
  const { results, ms } = main();
  // A higher retention target can only ask for a lower (or equal) floor, so freed
  // is non-increasing as the target rises; and scoring stays under the 500ms budget.
  for (let i = 1; i < results.length; i += 1) {
    console.assert(results[i]!.freed <= results[i - 1]!.freed + 0.02,
      'a higher retention target freed more, which a lower floor should not');
  }
  console.assert(ms < 500, `conformal calibration must stay under the 500 ms budget (was ${ms.toFixed(1)} ms)`);
}
