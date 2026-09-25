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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { outOfFold } from './logistic.js';
import { featureVector } from '../src/features.js';
import type { LabelRow } from './extract-labels.js';

const rows: LabelRow[] = readFileSync(join(import.meta.dirname, 'labels.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LabelRow);

const xs = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
const ys = rows.map((r) => (r.result_needed ? 1 : 0));
const score = new Map(rows.map((r, i) => [r.tool_use_id, 0]));
outOfFold(rows, xs, ys).forEach((p, i) => score.set(rows[i]!.tool_use_id, p));

const sessions = [...new Set(rows.map((r) => r.session))];

interface Outcome { freed: number; total: number; wrongDrops: number; needed: number; dropped: number; calls: number }

function simulate(policy: 'threshold' | 'budget', floor: number, target: number): Outcome {
  const out: Outcome = { freed: 0, total: 0, wrongDrops: 0, needed: 0, dropped: 0, calls: 0 };
  for (const session of sessions) {
    const calls = rows.filter((r) => r.session === session);
    out.total += calls.reduce((s, r) => s + r.output_chars, 0);
    out.calls += calls.length;
    out.needed += calls.filter((r) => r.result_needed).length;

    const below = calls.filter((r) => (score.get(r.tool_use_id) ?? 0) < floor);
    let toDrop = below;
    if (policy === 'budget') {
      const budget = target * below.reduce((s, r) => s + r.output_chars, 0);
      const order = [...below].sort((a, b) => (score.get(a.tool_use_id)! - score.get(b.tool_use_id)!));
      toDrop = [];
      let freed = 0;
      for (const r of order) {
        if (freed >= budget) break;
        toDrop.push(r);
        freed += r.output_chars;
      }
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
  console.log(
    `${name.padEnd(30)}${freedPct.toFixed(1).padStart(7)}%${String(o.dropped).padStart(8)}` +
    `${String(o.wrongDrops).padStart(12)}${retained.toFixed(1).padStart(10)}%`,
  );
};

console.log(`${rows.length} calls, ${rows.filter((r) => r.result_needed).length} genuinely needed, ${sessions.length} sessions\n`);
console.log(`${'policy'.padEnd(30)}${'freed'.padStart(8)}${'dropped'.padStart(8)}${'wrong drops'.padStart(12)}${'needed kept'.padStart(11)}`);
console.log('-'.repeat(69));
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
console.log('\n“needed kept” is the number that matters: a wrong drop is unrecoverable,');
console.log('while freeing a little less only costs context.');
