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
import { MUTATING } from '../src/state.js';
import { loadCorpus, rowKey } from './corpus.js';
import { DEFAULT_OPTIONS, decideAll } from '../src/compact.js';
import type { CallAnswer, ToolCall } from '../src/index.js';

/** Mirrors `decideCall`'s own list; a mutating call's input is the change record. */
import { outOfFoldScores } from './oof.js';

const { rows, from } = loadCorpus(import.meta.dirname);
/** The second model decides whether a drop keeps a head or removes the call. */
const { result: score, call: callScore } = outOfFoldScores(import.meta.dirname, rows);
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
  show(`budget ${target.toFixed(1)}, floor 0.20`, simulate('budget', 0.20, target));
}

// The rows above simulate the policy. This runs the shipped code, so it also
// carries `decideCall`'s guarantee that a mutating call is never dropped — which
// the simulation has no notion of, and which moves the figure slightly.
{
  let freed = 0;
  let total = 0;
  let needed = 0;
  let kept = 0;
  let mutatingDropped = 0;
  let mutatingRescued = 0;
  for (const session of sessions) {
    const calls = rows.filter((row) => row.session === session);
    const asToolCalls: ToolCall[] = calls.map((row) => ({
      id: rowKey(row), tool_use_id: rowKey(row), tool: row.tool, input: {},
      callIndex: 0, resultIndex: 1, resultText: '', resultChars: row.output_chars,
      isError: row.is_error, pinned: false,
    }));
    const answers = new Map<string, CallAnswer>(calls.map((row) => [
      rowKey(row),
      { keepResult: score.get(rowKey(row))!, keepCall: callScore.get(rowKey(row))! },
    ]));
    const actions = new Map(decideAll(asToolCalls, answers, DEFAULT_OPTIONS).map((d) => [d.id, d.action]));
    // The same calls with the mutating tool names swapped out, so decideCall's
    // never-drop guard does not fire. Scores come from the cache and are keyed
    // by row, not recomputed from the name, so this isolates the guard and
    // nothing else. The page used to say the rule "rescues 220 calls", which is
    // how many it applies to, not how many it saves.
    const unguarded = new Map(decideAll(
      asToolCalls.map((c) => (MUTATING.has(c.tool) ? { ...c, tool: 'Bash' } : c)),
      answers, DEFAULT_OPTIONS,
    ).map((d) => [d.id, d.action]));
    for (const row of calls) {
      const action = actions.get(rowKey(row))!;
      total += row.output_chars;
      /**
       * What survives this call, as a prefix length, the way `applyDecisions`
       * actually leaves it.
       *
       * Two corrections. A dropped RESULT keeps `truncateHeadChars`, and this
       * used to count the whole output as freed, overstating the figure. And
       * `maxKeptChars` caps whatever is left — the shipped default since the
       * size distribution turned out to put half of all output in about 3% of
       * calls — which this did not model at all, understating it.
       */
      let prefix = action === 'drop_call' ? 0
        : action === 'drop_result' ? Math.min(DEFAULT_OPTIONS.truncateHeadChars, row.output_chars)
        : row.output_chars;
      if (DEFAULT_OPTIONS.maxKeptChars > 0) prefix = Math.min(prefix, DEFAULT_OPTIONS.maxKeptChars);
      freed += row.output_chars - prefix;
      if (MUTATING.has(row.tool) && action === 'drop_call') mutatingDropped += 1;
      if (MUTATING.has(row.tool) && unguarded.get(rowKey(row)) !== 'keep') mutatingRescued += 1;
      if (!row.result_needed) continue;
      needed += 1;
      if (action === 'keep') kept += 1;
    }
  }
  console.log(`\nshipped code path (src/compact.ts decideAll, the same defaults):`);
  console.log(`  ${((100 * freed) / total).toFixed(1)}% freed, ` +
    `${((100 * kept) / needed).toFixed(1)}% of reused outputs kept, ` +
    `${mutatingDropped} of ${rows.filter((r) => MUTATING.has(r.tool)).length} mutating calls dropped`);
  console.log(`  without that guard ${mutatingRescued} of them would lose their call or output, ` +
    `so the rule saves ${mutatingRescued}, not ${rows.filter((r) => MUTATING.has(r.tool)).length}`);
}

console.log('\nwrong  = needed outputs that were dropped anyway');
console.log('+head  = of those, how many kept their first 300 characters');
console.log('kept   = share of needed outputs not dropped at all');
console.log('chars kept = share of needed CHARACTERS still present afterwards,');
console.log('             counting the heads that survived a partial drop.');
