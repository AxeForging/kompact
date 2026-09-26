/**
 * Where to answer a compaction, and how much a pass must reclaim to be worth it.
 *
 * The two settings that decide the whole loop ship as `compactAtPercent: 60`
 * and `minFreedPercent: 5`, and neither number has ever been swept. 60 came
 * from "well before the engine would ask" and 5 from a single comparison
 * against the `minReductionRatio: 0.25` rule it replaced. This asks the grid.
 *
 * Two questions, and the second is the one that matters:
 *
 *   1. **What does each setting free?** More passes, taken earlier, free more
 *      window and defer more model summaries. On its own that argues for
 *      compacting constantly, which is obviously wrong.
 *   2. **What does the work after it lose?** Every labelled call carries
 *      `first_reuse_index`, the message that first quoted its output verbatim.
 *      A pass that drops an output whose reuse is still ahead of it has removed
 *      something the session went on to need. Counting those *within the next N
 *      messages* is the continuity measure: a loss ten messages later is the
 *      assistant losing the thread it was holding, and a loss four hundred
 *      messages later is a different and much weaker claim.
 *
 * It calls the shipped `decideHandover` and `decideAll` rather than
 * reimplementing the rule, so what is swept is the product and not a model of
 * it. What it still is not is a replay: nothing here runs an assistant against
 * the compacted transcript, so this measures when the information stops being
 * there, which is the necessary condition for the work to suffer.
 *
 * ## What this measures, and the axis on which it must not be believed
 *
 * The labelled corpus carries tool OUTPUT only. A real transcript is roughly
 * 47% tool output, 44% tool input and the rest prose (`eval/inputs.ts`), and
 * compaction only ever touches the first two. So the window this fills is made
 * entirely of the most compactible material there is, and a pass that reclaims
 * a quarter of *this* window reclaims about eight points of a real one.
 *
 * That makes the **floor axis of this sweep wrong**, and it was believed once
 * before it was checked. This table rated a 15pp floor as costing 8% of what
 * is freed; run against real transcripts with full token accounting, a 15pp
 * floor takes **0 of 14 passes** and disables the ladder outright. The floor
 * question belongs to `eval/passes.ts`, which counts whole transcripts:
 *
 *     for at in 50 60 70 80 90; do for fl in 3 4 5 7 10 15; do
 *       bun eval/passes.ts --at $at --floor $fl; done; done
 *
 * The **trigger axis survives**, because it is a position in the session rather
 * than a quantity of window, and both measurements agree on its direction:
 * later frees more, because more compactible material has accumulated.
 *
 * What this script is still the only source of is the **continuity** column.
 * `first_reuse_index` exists only on the labelled corpus, so nothing else can
 * say whether a dropped output was one the next ten messages went on to quote.
 * Read the `<10` / `<25` / `<50` columns and the at-risk count; take the freed
 * column as a ranking within one window size and never as points of a real one.
 *
 * Run: bun eval/trigger.ts [--window 40000] [--max 6] [--within 10,25,50]
 */
import { loadCorpus, rowKey } from './corpus.js';
import { outOfFoldScores } from './oof.js';
import { DEFAULT_OPTIONS, decideAll, freedBy, tokensIn } from '../src/compact.js';
import { decideHandover } from '../hooks/kompact.js';
import type { CallAnswer, ToolCall } from '../src/index.js';
import type { LabelRow } from './extract-labels.js';

const args = process.argv.slice(2);
const num = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const numbers = (name: string, fallback: number[]): number[] => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const parsed = String(args[index + 1] ?? '').split(',').map(Number).filter(Number.isFinite);
  return parsed.length > 0 ? parsed : fallback;
};

const WINDOW = num('--window', 40_000);
const MAX_PASSES = num('--max', 6);
/** Horizons for "the next N messages", in messages of the real transcript. */
const WITHIN = numbers('--within', [10, 25, 50]);
const TRIGGERS = numbers('--at', [50, 60, 70, 80, 90]);
const FLOORS = numbers('--floor', [5, 10, 15, 25, 50]);

const { rows, from } = loadCorpus(import.meta.dirname);
if (rows[0]?.first_reuse_index === undefined) {
  throw new Error('this corpus predates first_reuse_index; re-run eval/extract-labels.ts');
}
const { result: resultScore, call: callScore } = outOfFoldScores(import.meta.dirname, rows);

const sessions = new Map<string, LabelRow[]>();
for (const row of rows) {
  const held = sessions.get(row.session) ?? [];
  held.push(row);
  sessions.set(row.session, held);
}
for (const [name, held] of sessions) {
  if (held.length < 5) sessions.delete(name);
  else held.sort((a, b) => a.result_index - b.result_index);
}

/**
 * Sessions big enough to reach the *highest* trigger in the grid.
 *
 * Without this every row of the table compares a different set of sessions: a
 * 90% trigger is only reached by the largest, so it would look safest simply by
 * never firing on the sessions where losses happen. Same sessions in every
 * cell, and the count is printed so the reader can see how small it is.
 */
const highest = Math.max(...TRIGGERS);
const eligible = [...sessions.values()].filter((held) =>
  tokensIn(held.reduce((sum, row) => sum + row.output_chars, 0)) >= (WINDOW * highest) / 100);

type Stat = {
  passes: number; handover: boolean; ceiling: boolean;
  freed: number; atRisk: number; lost: number;
  /** Lost outputs whose reuse was within N messages of the pass that dropped them. */
  near: number[];
};
const empty = (): Stat => ({
  passes: 0, handover: false, ceiling: false, freed: 0, atRisk: 0, lost: 0,
  near: WITHIN.map(() => 0),
});

/**
 * One session's loop at one (trigger, floor) setting.
 *
 * `live` is what the engine would be holding, `prefix` how much of each call's
 * output survives so far. When the live tokens reach the trigger that is a
 * compaction the engine asks for; kompact decides over exactly the live set and
 * the shipped `decideHandover` says whether the pass is worth taking. A refused
 * pass ends the loop, which is the hand-over to the model summary.
 */
function runSession(held: readonly LabelRow[], at: number, floor: number): Stat {
  const stat = empty();
  const trigger = (WINDOW * at) / 100;
  const prefix = new Map<string, number>();
  let live: LabelRow[] = [];
  let taken = 0;
  // Distinct outputs, not exposures: a row that survives four passes was
  // counted four times by the first version of this, which made a setting that
  // takes more passes look like it puts more at risk when it is the same
  // outputs being carried forward.
  const atRisk = new Set<string>();

  const liveTokens = (): number =>
    tokensIn(live.reduce((sum, row) => sum + (prefix.get(rowKey(row)) ?? 0), 0));

  for (const row of held) {
    live.push(row);
    prefix.set(rowKey(row), row.output_chars);
    const before = liveTokens();
    if (before < trigger) continue;

    const point = row.result_index;
    const calls: ToolCall[] = live.map((r) => ({
      id: rowKey(r), tool_use_id: rowKey(r), tool: r.tool, input: {},
      callIndex: 0, resultIndex: r.result_index, resultText: '',
      resultChars: prefix.get(rowKey(r)) ?? r.output_chars,
      isError: r.is_error, pinned: false,
    }));
    const answers = new Map<string, CallAnswer>(live.map((r) => [
      rowKey(r),
      { keepResult: resultScore.get(rowKey(r))!, keepCall: callScore.get(rowKey(r))! },
    ]));
    const byId = new Map(calls.map((call) => [call.id, call]));
    const decisions = decideAll(calls, answers, DEFAULT_OPTIONS);

    let freedChars = 0;
    const survivors: LabelRow[] = [];
    const casualties: Array<{ row: LabelRow; freed: number }> = [];
    for (const decision of decisions) {
      const r = live.find((x) => rowKey(x) === decision.id)!;
      const call = byId.get(decision.id)!;
      const freed = Math.max(0, freedBy(call, decision.action, DEFAULT_OPTIONS.truncateHeadChars,
        DEFAULT_OPTIONS.maxKeptChars));
      freedChars += freed;
      if (decision.action === 'drop_call') {
        casualties.push({ row: r, freed });
        continue;
      }
      if (decision.action === 'drop_result') casualties.push({ row: r, freed });
      prefix.set(rowKey(r), Math.max(0, call.resultChars - freed));
      survivors.push(r);
    }

    const freedTokens = tokensIn(freedChars);
    const { take } = decideHandover({
      freedTokens, tokensBefore: before, windowTokens: WINDOW, passes: taken,
      config: { minFreedPercent: floor, maxPasses: MAX_PASSES, compactAtPercent: at },
    });
    if (!take) {
      stat.handover = true;
      stat.ceiling = taken >= MAX_PASSES;
      break;
    }

    // Charged only for outputs whose first reuse is still ahead of this pass:
    // a reuse that already happened was never at risk from it.
    for (const r of live) if (r.first_reuse_index > point) atRisk.add(rowKey(r));
    for (const { row: r, freed } of casualties) {
      if (r.first_reuse_index <= point || freed === 0) continue;
      stat.lost += 1;
      for (const [index, horizon] of WITHIN.entries()) {
        if (r.first_reuse_index - point <= horizon) stat.near[index] += 1;
      }
    }
    stat.freed += freedTokens;
    stat.passes += 1;
    taken += 1;
    const kept = new Set(survivors);
    for (const r of live) if (!kept.has(r)) prefix.delete(rowKey(r));
    live = survivors;
  }
  stat.atRisk = atRisk.size;
  return stat;
}

/**
 * Resampled over sessions, because the events being counted are single digits.
 *
 * The first run of this ranked twenty-five settings on totals like "2 outputs
 * lost" and "0 outputs lost" over fifteen sessions, and the ranking flipped
 * when the window changed. That is not a measurement, it is a coin. The per-
 * session stats are computed once per cell and resampled with replacement here,
 * so every figure carries the spread it is actually known to.
 */
const BOOT = num('--boot', 400);
const SEED = num('--seed', 20250926);

/** xorshift32: a seeded generator, so a reported spread is reproducible. */
function rng(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const sum = (stats: readonly Stat[], pick: (s: Stat) => number): number =>
  stats.reduce((total, stat) => total + pick(stat), 0);
const rateOf = (stats: readonly Stat[]): number => {
  const freed = sum(stats, (s) => s.freed);
  return freed === 0 ? 0 : (10_000 * sum(stats, (s) => s.lost)) / freed;
};

interface Spread { mean: number; sd: number }
function spread(values: readonly number[]): Spread {
  const mean = values.reduce((t, v) => t + v, 0) / Math.max(1, values.length);
  const variance = values.reduce((t, v) => t + (v - mean) ** 2, 0) / Math.max(1, values.length);
  return { mean, sd: Math.sqrt(variance) };
}
const pm = (s: Spread, digits = 3): string =>
  `${s.mean.toFixed(digits)}±${s.sd.toFixed(digits)}`;

console.log(`\n${from}: ${rows.length} calls, ${sessions.size} sessions`);
console.log(`window ${WINDOW.toLocaleString()} tokens, ceiling ${MAX_PASSES} passes, `
  + `${eligible.length} sessions reach the ${highest}% trigger and are the set every cell uses`);
console.log(`${BOOT} bootstrap resamples over sessions, seed ${SEED}`);
// Printed, not buried in the header comment, because the first reading of this
// table produced a recommendation that would have disabled the ladder.
console.log('\nNOTE: this corpus is tool output only, so a point of THIS window is roughly');
console.log('two points of a real one. The floor column is not comparable to the shipped');
console.log('setting — use eval/passes.ts for that. The trigger column and the continuity');
console.log('columns are what this table is for.\n');

const header = `${'trigger'.padStart(8)}${'floor'.padStart(7)}${'passes'.padStart(7)}`
  + `${'hand'.padStart(6)}${'freed/session'.padStart(20)}${'at risk'.padStart(9)}`
  + `${'lost'.padStart(6)}`
  + WITHIN.map((n) => `<${n}`.padStart(6)).join('')
  + `${'lost per 10k freed'.padStart(22)}`;
console.log(header);
console.log('-'.repeat(header.length));

type Result = {
  at: number; floor: number; stats: Stat[];
  rate: Spread; freed: Spread; passes: number; lost: number; near: number[];
};
const results: Result[] = [];
for (const at of TRIGGERS) {
  for (const floor of FLOORS) {
    const stats = eligible.map((held) => runSession(held, at, floor));
    const draw = rng(SEED + at * 1000 + floor);
    const rates: number[] = [];
    const freeds: number[] = [];
    for (let b = 0; b < BOOT; b += 1) {
      const sample = stats.map(() => stats[Math.floor(draw() * stats.length)]!);
      rates.push(rateOf(sample));
      freeds.push(sum(sample, (s) => s.freed) / sample.length);
    }
    const near = WITHIN.map((_, i) => sum(stats, (s) => s.near[i]!));
    const result: Result = {
      at, floor, stats,
      rate: spread(rates), freed: spread(freeds),
      passes: sum(stats, (s) => s.passes), lost: sum(stats, (s) => s.lost), near,
    };
    results.push(result);
    console.log(
      `${`${at}%`.padStart(8)}${`${floor}pp`.padStart(7)}${String(result.passes).padStart(7)}`
      + `${String(stats.filter((s) => s.handover).length).padStart(6)}`
      + `${`${Math.round(result.freed.mean).toLocaleString()}±${Math.round(result.freed.sd).toLocaleString()}`.padStart(20)}`
      + `${String(sum(stats, (s) => s.atRisk)).padStart(9)}`
      + `${String(result.lost).padStart(6)}`
      + near.map((n) => String(n).padStart(6)).join('')
      + `${pm(result.rate).padStart(22)}`,
    );
  }
  console.log('');
}

/**
 * The comparison the question asks for, with the spread doing the deciding.
 *
 * Two settings are only different if their intervals do not overlap. Ranking on
 * a point estimate when every interval covers zero is how a coin flip gets
 * published as a recommendation.
 */
const shipped = results.find((r) => r.at === 60 && r.floor === 5)!;
const useful = results.filter((r) => r.passes > 0);
const byRate = [...useful].sort((a, b) => a.rate.mean - b.rate.mean || b.freed.mean - a.freed.mean);
const byFreed = [...useful].sort((a, b) => b.freed.mean - a.freed.mean);

console.log('most freed per session, best first:');
for (const r of byFreed.slice(0, 5)) {
  console.log(`  at ${String(r.at).padStart(2)}%, floor ${String(r.floor).padStart(2)}pp: `
    + `${Math.round(r.freed.mean).toLocaleString()}±${Math.round(r.freed.sd).toLocaleString()} tokens, `
    + `${r.passes} passes, ${r.lost} lost (${r.rate.mean.toFixed(3)}±${r.rate.sd.toFixed(3)} per 10k)`);
}

console.log('\nshipped (60%, 5pp):');
console.log(`  ${Math.round(shipped.freed.mean).toLocaleString()}±${Math.round(shipped.freed.sd).toLocaleString()} tokens a session, `
  + `${shipped.passes} passes, ${shipped.lost} lost, ${pm(shipped.rate)} per 10k`);

/** How many settings are distinguishable from the shipped one at all. */
const separated = useful.filter((r) =>
  Math.abs(r.rate.mean - shipped.rate.mean) > 2 * Math.hypot(r.rate.sd, shipped.rate.sd));
console.log(`\n${separated.length} of ${useful.length} settings differ from shipped by more than`);
console.log(`two combined standard deviations on the exchange rate.`);
if (separated.length === 0) {
  console.log('On this corpus the loss side of the question is not decidable: every setting');
  console.log('costs the same as every other, within the spread. Decide it on what is freed');
  console.log('and on how many model summaries are deferred, and keep the loss column as the');
  console.log('safety check it is — no setting in the grid made it blow up.');
}
const nearTotal = results.reduce((t, r) => t + (r.near[0] ?? 0), 0);
console.log(`\nacross all ${results.length} settings, ${nearTotal} outputs were lost whose reuse`);
console.log(`was within ${WITHIN[0]} messages of the pass that dropped them.`);
console.log('\nThe floor column above is in this corpus\u2019s units, not a real transcript\u2019s:');
console.log('on whole transcripts a 15pp floor takes 0 of 14 passes. Read the trigger and');
console.log('continuity columns here, and eval/passes.ts for the floor.');
console.log('\nNothing here replays an assistant against the compacted transcript: this is when');
console.log('the information stops being there, which is the necessary condition for the work');
console.log('to suffer rather than proof that it did.');
