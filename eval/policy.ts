/**
 * Threshold policy vs budget policy, on the labelled corpus.
 *
 * Compaction happens inside one session, so both policies are simulated per
 * session and aggregated. Scores are leave-one-session-out, never in-sample.
 *
 * The question is not which frees more — dropping everything frees most. It is
 * which frees a useful amount while keeping the outputs that were genuinely
 * reused later.
 *
 * Run: bun eval/policy.ts
 */
import { loadCorpus, rowKey } from './corpus.js';
import { outOfFold } from './logistic.js';
import { featureVector } from '../src/features.js';

const { rows, from } = loadCorpus(import.meta.dirname);

const xs = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
const score = new Map<string, number>();
outOfFold(rows, xs, rows.map((r) => (r.result_needed ? 1 : 0)))
  .forEach((p, i) => score.set(rowKey(rows[i]!), p));
/** The second model decides whether a drop keeps a head or removes the call. */
const callScore = new Map<string, number>();
outOfFold(rows, xs, rows.map((r) => (r.call_needed ? 1 : 0)))
  .forEach((p, i) => callScore.set(rowKey(rows[i]!), p));
/** What `truncateHeadChars` preserves when only the result is dropped. */
const HEAD = 300;

const sessions = [...new Set(rows.map((r) => r.session))];

interface Outcome {
  freed: number; total: number; wrongDrops: number; needed: number; dropped: number; calls: number;
  /** Wrong drops that kept a head, so the content is partly still there. */
  wrongWithHead: number;
  /** Characters of genuinely-needed output that survived a wrong drop. */
  neededCharsKept: number;
  neededCharsTotal: number;
}

function simulate(policy: 'threshold' | 'budget', floor: number, target: number): Outcome {
  const out: Outcome = { freed: 0, total: 0, wrongDrops: 0, needed: 0, dropped: 0, calls: 0,
    wrongWithHead: 0, neededCharsKept: 0, neededCharsTotal: 0 };
  for (const session of sessions) {
    const calls = rows.filter((r) => r.session === session);
    out.total += calls.reduce((s, r) => s + r.output_chars, 0);
    out.calls += calls.length;
    out.needed += calls.filter((r) => r.result_needed).length;

    const below = calls.filter((r) => (score.get(rowKey(r)) ?? 0) < floor);
    let toDrop = below;
    if (policy === 'budget') {
      const budget = target * below.reduce((s, r) => s + r.output_chars, 0);
      const order = [...below].sort((a, b) => (score.get(rowKey(a))! - score.get(rowKey(b))!));
      toDrop = [];
      let freed = 0;
      for (const r of order) {
        if (freed >= budget) break;
        toDrop.push(r);
        freed += r.output_chars;
      }
    }
    const droppedIds = new Set(toDrop.map(rowKey));
    for (const r of calls) {
      if (!r.result_needed) continue;
      out.neededCharsTotal += r.output_chars;
      if (!droppedIds.has(rowKey(r))) { out.neededCharsKept += r.output_chars; continue; }
      // Dropped although it was needed. A head survives unless the call itself
      // also scored below the floor and was removed outright.
      const keepsHead = (callScore.get(rowKey(r)) ?? 0) >= floor;
      if (keepsHead) { out.wrongWithHead += 1; out.neededCharsKept += Math.min(HEAD, r.output_chars); }
    }
    for (const r of toDrop) {
      out.freed += r.output_chars;
      out.dropped += 1;
      if (r.result_needed) out.wrongDrops += 1;
    }
  }
  return out;
}

const show = (name: string, o: Outcome): void => {
  const freedPct = (100 * o.freed) / o.total;
  const retained = o.needed === 0 ? 100 : (100 * (o.needed - o.wrongDrops)) / o.needed;
  const charsKept = o.neededCharsTotal === 0 ? 100 : (100 * o.neededCharsKept) / o.neededCharsTotal;
  console.log(
    `${name.padEnd(28)}${freedPct.toFixed(1).padStart(7)}%${String(o.wrongDrops).padStart(8)}` +
    `${String(o.wrongWithHead).padStart(7)}${retained.toFixed(1).padStart(9)}%${charsKept.toFixed(1).padStart(10)}%`,
  );
};

console.log(`${from}: ${rows.length} calls, ${rows.filter((r) => r.result_needed).length} genuinely needed, ${sessions.length} sessions\n`);
console.log(`${'policy'.padEnd(28)}${'freed'.padStart(8)}${'wrong'.padStart(8)}${'+head'.padStart(7)}${'kept'.padStart(9)}${'chars kept'.padStart(11)}`);
console.log('-'.repeat(71));
show('threshold only, 0.5 (old)', simulate('threshold', 0.5, 0));
console.log();
for (const floor of [0.5, 0.3, 0.2, 0.15, 0.1, 0.05]) {
  for (const target of [0.7]) {
    show(`budget ${target.toFixed(1)}, floor ${floor.toFixed(2)}`, simulate('budget', floor, target));
  }
}
console.log();
for (const target of [0.5, 0.6, 0.7, 0.8]) {
  show(`budget ${target.toFixed(1)}, floor 0.10`, simulate('budget', 0.10, target));
}
console.log('\nwrong  = needed outputs that were dropped anyway');
console.log('+head  = of those, how many kept their first 300 characters');
console.log('kept   = share of needed outputs not dropped at all');
console.log('chars kept = share of needed CHARACTERS still present afterwards,');
console.log('             counting the heads that survived a partial drop.');
