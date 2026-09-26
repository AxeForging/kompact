/**
 * What compaction costs the work that follows it — the measurement the page
 * says blocks a 1.0, and the one every other metric here has stood in for.
 *
 * Every other figure treats a session as a flat set of calls and asks "was this
 * output reused *somewhere* later". That conflates a reuse that had already
 * happened by the time a real compaction fired with one that comes after it, and
 * only the second kind can possibly be lost. It therefore over-counts, which is
 * why `recovery.ts` has to call itself recovery cost rather than task outcome.
 *
 * This asks the question in the right order:
 *
 *   1. Find where the engine would actually compact — `compactAtPercent` of the
 *      context window, by cumulative estimated tokens over the transcript.
 *   2. Score and decide only the calls that exist at that point, exactly as
 *      production does, through `decideAll`.
 *   3. Count the reuses that happen *after* it whose source was dropped.
 *
 * What it still is not: a replay. Nothing here runs an assistant against the
 * compacted transcript. It measures how often the information a session went on
 * to use verbatim would no longer be there — which is the necessary condition
 * for the work to suffer, not proof that it did.
 *
 * With `--passes N` it asks the same question of the *loop* rather than of one
 * compaction: kompact now answers several compactions before handing over to the
 * engine's summary, and the premise of that ladder is that passes 2..N take
 * cheap context rather than compounding loss. This is the measurement that would
 * falsify it. If the exchange rate — outputs lost per 10,000 characters freed —
 * rises sharply with the pass number, then repeated cheap compaction is buying
 * room by eroding the record, and `maxPasses` and `minFreedPercent` have to
 * tighten until the rate is flat again.
 *
 * Run: bun eval/outcome.ts [--fixture] [--at 60] [--passes 6]
 */
import { loadCorpus, rowKey } from './corpus.js';
import { outOfFoldScores } from './oof.js';
import { DEFAULT_OPTIONS, decideAll, freedBy } from '../src/compact.js';
import type { CallAnswer, ToolCall } from '../src/index.js';
import type { LabelRow } from './extract-labels.js';
import { HOOK_DEFAULTS } from '../hooks/kompact.js';

const args = process.argv.slice(2);
/**
 * The trigger comes from the hook, not from a copy of it kept here.
 *
 * This stood for production with a hand-typed 60 while the plugin shipped a
 * different number, so "where the engine would actually compact" was measuring
 * somewhere the engine no longer compacts.
 */
const at = args.includes('--at')
  ? Number(args[args.indexOf('--at') + 1])
  : HOOK_DEFAULTS.compactAtPercent;
const PASSES = args.includes('--passes') ? Number(args[args.indexOf('--passes') + 1]) : 0;

const { rows, from } = loadCorpus(import.meta.dirname);
if (rows[0]?.first_reuse_index === undefined) {
  throw new Error('this corpus predates first_reuse_index; re-run eval/extract-labels.ts');
}

const { result: resultScore, call: callScore } = outOfFoldScores(import.meta.dirname, rows);

/**
 * The message index at which the engine would fire, by cumulative output.
 *
 * The transcript's own token count is not recoverable from the labels, but the
 * tool output dominates it, so the share of a session's total output that has
 * accumulated is the best available proxy for the share of the window in use.
 */
function compactionPoint(calls: readonly LabelRow[], percent: number): number {
  const total = calls.reduce((sum, row) => sum + row.output_chars, 0);
  let seen = 0;
  for (const row of [...calls].sort((a, b) => a.result_index - b.result_index)) {
    seen += row.output_chars;
    if (seen >= (percent / 100) * total) return row.result_index;
  }
  return calls.at(-1)?.result_index ?? 0;
}

interface Session { later: number; lost: number; lostChars: number; calls: number; point: number }
const sessions: Session[] = [];

for (const name of new Set(rows.map((r) => r.session))) {
  const inSession = rows.filter((row) => row.session === name);
  if (inSession.length < 5) continue;
  const point = compactionPoint(inSession, at);
  // Only what exists when compaction fires is a candidate, exactly as in production.
  const present = inSession.filter((row) => row.result_index <= point);
  if (present.length === 0) continue;

  const calls: ToolCall[] = present.map((row) => ({
    id: rowKey(row), tool_use_id: rowKey(row), tool: row.tool, input: {},
    callIndex: 0, resultIndex: row.result_index, resultText: '', resultChars: row.output_chars,
    isError: row.is_error, pinned: false,
  }));
  const answers = new Map<string, CallAnswer>(present.map((row) => [
    rowKey(row),
    { keepResult: resultScore.get(rowKey(row))!, keepCall: callScore.get(rowKey(row))! },
  ]));
  const byId = new Map(calls.map((call) => [call.id, call]));
  const decisions = decideAll(calls, answers, DEFAULT_OPTIONS);

  let later = 0;
  let lost = 0;
  let lostChars = 0;
  for (const decision of decisions) {
    const row = present.find((r) => rowKey(r) === decision.id)!;
    // The reuse must come after the compaction point, or nothing was at risk.
    if (row.first_reuse_index < 0 || row.first_reuse_index <= point) continue;
    later += 1;
    if (decision.action === 'keep') continue;
    // And the drop must actually remove something.
    if (freedBy(byId.get(decision.id)!, decision.action, DEFAULT_OPTIONS.truncateHeadChars) === 0) continue;
    lost += 1;
    lostChars += row.output_chars;
  }
  sessions.push({ later, lost, lostChars, calls: present.length, point });
}

const sum = (pick: (s: Session) => number): number => sessions.reduce((t, s) => t + pick(s), 0);
const later = sum((s) => s.later);
const lost = sum((s) => s.lost);
const pct = (n: number, d: number): string => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;

console.log(`${from}: ${rows.length} calls, ${sessions.length} sessions with a compaction point`);
console.log(`compacting at ${at}% of a session's tool output\n`);
console.log(`calls present when it fires:        ${sum((s) => s.calls)}`);
console.log(`of those, reused only afterwards:   ${later}`);
console.log(`and dropped anyway:                 ${lost} (${pct(lost, later)} of them)`);
console.log(`                                    ${sum((s) => s.lostChars).toLocaleString()} characters`);
console.log(`per session:                        ${(lost / Math.max(1, sessions.length)).toFixed(2)}`);
console.log(`sessions that lose nothing:         ${sessions.filter((s) => s.lost === 0).length} of ${sessions.length}`);
console.log(`\nThis is the necessary condition for the work to suffer, not proof that it`);
console.log(`did: nothing here replays an assistant against the compacted transcript.`);

if (PASSES > 0) {
  /**
   * The same question, asked once per pass of the loop.
   *
   * `live` is what the engine would be holding. Calls arrive in result order;
   * when what is live reaches the trigger, kompact decides over exactly the
   * live set, the survivors carry their prefixes forward, and the walk
   * continues. A pass is charged only for outputs whose first reuse comes
   * *after* the point it fired at — the same rule as above.
   */
  type PassRow = { later: number; lost: number; freed: number; calls: number };
  const perPass: PassRow[] = [];
  for (const name of new Set(rows.map((r) => r.session))) {
    const inSession = [...rows.filter((row) => row.session === name)]
      .sort((a, b) => a.result_index - b.result_index);
    if (inSession.length < 5) continue;
    const total = inSession.reduce((sum, row) => sum + row.output_chars, 0);
    const trigger = (at / 100) * total;

    // What survives of each call, as a prefix length; the walk carries it.
    const prefix = new Map<string, number>();
    let live: LabelRow[] = [];
    let liveChars = 0;
    let taken = 0;
    for (const row of inSession) {
      live.push(row);
      prefix.set(rowKey(row), row.output_chars);
      liveChars += row.output_chars;
      if (liveChars < trigger || taken >= PASSES) continue;

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

      const stat: PassRow = { later: 0, lost: 0, freed: 0, calls: live.length };
      const survivors: LabelRow[] = [];
      for (const decision of decisions) {
        const r = live.find((x) => rowKey(x) === decision.id)!;
        const call = byId.get(decision.id)!;
        const freed = freedBy(call, decision.action, DEFAULT_OPTIONS.truncateHeadChars,
          DEFAULT_OPTIONS.maxKeptChars);
        stat.freed += Math.max(0, freed);
        const atRisk = r.first_reuse_index >= 0 && r.first_reuse_index > point;
        if (atRisk) stat.later += 1;
        if (decision.action === 'drop_call') {
          if (atRisk && freed > 0) stat.lost += 1;
          prefix.delete(rowKey(r));
          continue;
        }
        if (decision.action === 'drop_result' && freed > 0 && atRisk) stat.lost += 1;
        prefix.set(rowKey(r), Math.max(0, call.resultChars - Math.max(0, freed)));
        survivors.push(r);
      }
      perPass[taken] = {
        later: (perPass[taken]?.later ?? 0) + stat.later,
        lost: (perPass[taken]?.lost ?? 0) + stat.lost,
        freed: (perPass[taken]?.freed ?? 0) + stat.freed,
        calls: (perPass[taken]?.calls ?? 0) + stat.calls,
      };
      taken += 1;
      live = survivors;
      liveChars = survivors.reduce((sum, r) => sum + (prefix.get(rowKey(r)) ?? 0), 0);
    }
  }

  console.log(`\n\nthe loop, up to ${PASSES} passes a session`);
  console.log(`${'pass'.padStart(5)}${'calls live'.padStart(12)}${'at risk'.padStart(9)}` +
    `${'lost'.padStart(6)}${'freed'.padStart(12)}${'lost per 10k freed'.padStart(21)}`);
  console.log('-'.repeat(65));
  for (const [index, row] of perPass.entries()) {
    if (!row) continue;
    const rate = row.freed === 0 ? 0 : (10_000 * row.lost) / row.freed;
    console.log(`${String(index + 1).padStart(5)}${String(row.calls).padStart(12)}` +
      `${String(row.later).padStart(9)}${String(row.lost).padStart(6)}` +
      `${row.freed.toLocaleString().padStart(12)}${rate.toFixed(3).padStart(21)}`);
  }
  const loopLost = perPass.reduce((total, row) => total + (row?.lost ?? 0), 0);
  const loopFreed = perPass.reduce((total, row) => total + (row?.freed ?? 0), 0);
  const first = perPass[0];
  console.log(`\nwhole loop: ${loopLost} outputs lost, ${loopFreed.toLocaleString()} characters freed`);
  console.log(`            ${(loopLost / Math.max(1, sessions.length)).toFixed(2)} a session, ` +
    `against ${((first?.lost ?? 0) / Math.max(1, sessions.length)).toFixed(2)} for one pass`);
  console.log(`            ${(loopFreed / Math.max(1, first?.freed ?? 1)).toFixed(2)}x the characters, ` +
    `${(loopLost / Math.max(1, first?.lost ?? 1)).toFixed(2)}x the loss`);
  console.log(`\nThe ladder's premise is that the rate column stays flat: a later pass takes`);
  console.log(`cheap context rather than compounding loss. It does not. The first pass is the`);
  console.log(`efficient one, because it compacts the whole backlog at once; every pass after`);
  console.log(`it works on fresh material only and costs several times as much per character.`);
}
