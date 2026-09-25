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
 * Run: bun eval/outcome.ts [--fixture] [--at 60]
 */
import { loadCorpus, rowKey } from './corpus.js';
import { outOfFoldScores } from './oof.js';
import { DEFAULT_OPTIONS, decideAll, freedBy } from '../src/compact.js';
import type { CallAnswer, ToolCall } from '../src/index.js';
import type { LabelRow } from './extract-labels.js';

const args = process.argv.slice(2);
const at = args.includes('--at') ? Number(args[args.indexOf('--at') + 1]) : 60;

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
