/**
 * Study 19 — do failed tool calls earn their keep?
 *
 * The question: should compaction drop failed/invalid tool calls and keep only
 * what succeeded? kompact already carries `isError` as a fitted scorer feature
 * (small negative weight), but it was never isolated. This measures, on the real
 * corpus with the real `decideAll`:
 *
 *   1. Base rate — do failed outputs get reused verbatim as often as successful
 *      ones, and how much of the total output mass do they even hold? (Failures
 *      are usually short, so dropping them may free almost nothing.)
 *   2. What the shipped policy already does to failures (the learned weight).
 *   3. A/B at the shipped threshold — a hard drop of failed/repeatable calls, and
 *      a stronger isError penalty — reporting freed, retention, and the safety
 *      cost (needed failed outputs lost). The tradeoff decides it, not AUC.
 *
 * Reproducible: committed fixture, shipped weights, no model.
 * Run: bun eval/error-policy.ts [--fixture] [--write]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureVector, score, KEEP_RESULT_WEIGHTS, KEEP_CALL_WEIGHTS } from '../src/features.js';
import { decideAll, DEFAULT_OPTIONS } from '../src/compact.js';
import { MUTATING, UNREPEATABLE } from '../src/state.js';
import { loadCorpus } from './corpus.js';
import type { ToolCall, CallAnswer } from '../src/index.js';

type Outcome = {
  kept: number; freed: number; failedDropRate: number; neededFailLost: number;
};

function main() {
  const args = process.argv.slice(2);
  const { rows, from } = loadCorpus(import.meta.dirname, { fixtureOnly: args.includes('--fixture') });
  const feats = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
  const bySession = new Map<string, number[]>();
  rows.forEach((r, i) => { const l = bySession.get(r.session) ?? []; l.push(i); bySession.set(r.session, l); });

  // 1) Base rates, split by error status: reuse rate and share of output mass.
  const group = (pred: (i: number) => boolean) => {
    let n = 0, needed = 0, chars = 0;
    rows.forEach((r, i) => {
      if (!pred(i)) return;
      n += 1; chars += r.output_chars; if (r.result_needed) needed += 1;
    });
    return { n, needed, reuse: n ? needed / n : 0, chars };
  };
  const failed = group((i) => rows[i]!.is_error);
  const ok = group((i) => !rows[i]!.is_error);
  const totalChars = failed.chars + ok.chars;
  const failedCharShare = totalChars ? failed.chars / totalChars : 0;

  // 2+3) Run the REAL policy at the shipped threshold. `penalty` lowers the
  // keep-result score of failed calls before the decider sees them; `hardDrop`
  // additionally drops any failed, repeatable, non-mutating call outright.
  const run = (penalty: number, hardDrop: boolean): Outcome => {
    let needed = 0, keptNeeded = 0, freed = 0, total = 0;
    let failedTotal = 0, failedDropped = 0, neededFailLost = 0;
    for (const idx of bySession.values()) {
      const calls: ToolCall[] = idx.map((i) => ({
        id: rows[i]!.tool_use_id, tool_use_id: rows[i]!.tool_use_id, tool: rows[i]!.tool, input: {},
        callIndex: 0, resultIndex: 1, resultText: '', resultChars: rows[i]!.output_chars,
        isError: rows[i]!.is_error, pinned: false,
      }));
      const ans = new Map<string, CallAnswer>(idx.map((i) => {
        let keepResult = score(KEEP_RESULT_WEIGHTS, feats[i]!);
        if (penalty && rows[i]!.is_error) keepResult = Math.max(0, keepResult - penalty);
        return [rows[i]!.tool_use_id, { keepResult, keepCall: score(KEEP_CALL_WEIGHTS, feats[i]!) }];
      }));
      const dropped = new Set(decideAll(calls, ans, DEFAULT_OPTIONS)
        .filter((d) => d.action !== 'keep').map((d) => d.id));
      if (hardDrop) {
        for (const i of idx) {
          const r = rows[i]!;
          if (r.is_error && !MUTATING.has(r.tool) && !UNREPEATABLE.has(r.tool)) dropped.add(r.tool_use_id);
        }
      }
      for (const i of idx) {
        const r = rows[i]!;
        total += r.output_chars;
        const isDropped = dropped.has(r.tool_use_id);
        if (isDropped) freed += r.output_chars;
        if (r.is_error) { failedTotal += 1; if (isDropped) failedDropped += 1; }
        if (r.result_needed) {
          needed += 1;
          if (!isDropped) keptNeeded += 1;
          if (r.is_error && isDropped) neededFailLost += 1;
        }
      }
    }
    return {
      kept: needed ? keptNeeded / needed : 1,
      freed: total ? freed / total : 0,
      failedDropRate: failedTotal ? failedDropped / failedTotal : 0,
      neededFailLost,
    };
  };

  const t0 = performance.now();
  const baseline = run(0, false);
  const hard = run(0, true);
  const penalties = [0.1, 0.2, 0.3].map((p) => ({ penalty: p, ...run(p, false) }));
  const ms = performance.now() - t0;

  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  console.log(`corpus (${from}): ${rows.length} calls, ${bySession.size} sessions`);
  console.log(`failed: ${failed.n} calls (${pct(failedCharShare)} of output chars), reuse ${pct(failed.reuse)}`);
  console.log(`succeeded: ${ok.n} calls, reuse ${pct(ok.reuse)}`);
  console.log(`shipped already drops ${pct(baseline.failedDropRate)} of failed calls\n`);

  console.log('policy            kept/needed   freed/total   failed dropped   needed-fail lost');
  const line = (name: string, o: Outcome) => console.log(
    `${name.padEnd(16)}  ${pct(o.kept).padStart(9)}   ${pct(o.freed).padStart(9)}   `
    + `${pct(o.failedDropRate).padStart(12)}   ${String(o.neededFailLost).padStart(14)}`);
  line('baseline', baseline);
  line('hard-drop', hard);
  for (const p of penalties) line(`penalty +${p.penalty}`, p);

  // Verdict: a policy wins only if it frees meaningfully MORE while keeping at
  // least as many needed outputs (Pareto). A gain that costs needed outputs, or a
  // gain too small to matter (failures hold little mass), confirms the design.
  const freedGain = Math.max(hard.freed, ...penalties.map((p) => p.freed)) - baseline.freed;
  const cleanWin = (hard.freed > baseline.freed + 0.01 && hard.kept >= baseline.kept - 0.001
    && hard.neededFailLost <= baseline.neededFailLost)
    || penalties.some((p) => p.freed > baseline.freed + 0.01 && p.kept >= baseline.kept - 0.001
      && p.neededFailLost <= baseline.neededFailLost);
  const verdict = cleanWin
    ? `WORTH TUNING: a drop/penalty policy frees materially more at no retention cost (+${pct(freedGain)} freed). Re-fit or add a guarded drop, judged on freed@retention.`
    : `CONFIRMS THE DESIGN: failures are ${pct(failedCharShare)} of output mass and the shipped weight already `
      + `drops ${pct(baseline.failedDropRate)} of them; a harder drop adds only +${pct(freedGain)} freed and `
      + `costs needed outputs. The learned isError feature already does the job — do not blind-drop.`;
  console.log(`\nspeed: ${ms.toFixed(1)} ms over ${rows.length} calls`);
  console.log(`verdict: ${verdict}`);

  const round = (o: Outcome) => ({
    kept: Number((100 * o.kept).toFixed(1)), freed: Number((100 * o.freed).toFixed(1)),
    failedDropRate: Number((100 * o.failedDropRate).toFixed(1)), neededFailLost: o.neededFailLost,
  });
  const fixture = {
    calls: rows.length, sessions: bySession.size,
    failed: { n: failed.n, reuse: Number((100 * failed.reuse).toFixed(1)),
      charShare: Number((100 * failedCharShare).toFixed(1)) },
    succeeded: { n: ok.n, reuse: Number((100 * ok.reuse).toFixed(1)) },
    baseline: round(baseline), hardDrop: round(hard),
    penalties: penalties.map((p) => ({ penalty: p.penalty, ...round(p) })),
    verdict,
  };
  if (args.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'error-policy.json'),
      JSON.stringify(fixture, null, 2) + '\n');
    console.log('\nwrote fixtures/error-policy.json');
  }
  return { baseline, hard, penalties, ms };
}

if (import.meta.main) {
  const { baseline, hard, ms } = main();
  // Self-checks use only properties that are definitionally true: hard-drop's
  // dropped set is a SUPERSET of baseline's (it only adds failed/repeatable calls),
  // so it can free no less, drop no fewer failed calls, and lose no fewer needed
  // failures. (freed is NOT monotonic in the penalty — `decideAll` is budgeted, so
  // lowering a failed call's score reshuffles which calls the budget spends on.)
  console.assert(hard.freed >= baseline.freed - 1e-9, 'hard-drop (a superset) freed less than baseline');
  console.assert(hard.failedDropRate >= baseline.failedDropRate - 1e-9,
    'hard-drop dropped fewer failed calls than baseline');
  console.assert(hard.neededFailLost >= baseline.neededFailLost,
    'hard-drop lost fewer needed failures than baseline');
  console.assert(baseline.kept >= 0 && baseline.kept <= 1 && baseline.freed >= 0 && baseline.freed <= 1,
    'retention/freed out of range');
  console.assert(ms < 500, `scoring must stay under the 500 ms budget (was ${ms.toFixed(1)} ms)`);
}
