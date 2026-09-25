/**
 * What a wrong drop actually costs.
 *
 * Every other metric here is a ranking or a character count. None of them says
 * what happens to the work when the scorer is wrong, and "77.3% of needed
 * outputs kept" invites the reader to supply their own answer for the other
 * 15.4%. This prices it: for each output the shipped policy drops although it
 * was reused later, can the assistant get it back, and at what cost.
 *
 * Read the limits before the numbers. This is a recovery-cost measurement, not
 * a task-outcome measurement:
 *
 *  - It does not replay a session. Nothing here shows an assistant given the
 *    compacted transcript still finishing the job; that needs a live A/B and is
 *    stated as unverified.
 *  - `result_needed` means the output was reproduced verbatim somewhere later in
 *    the recorded session. It does not distinguish a reuse that happened before
 *    a real compaction would have fired from one after it, so it over-counts:
 *    a reuse that already happened costs nothing when the output is dropped now.
 *  - Whether a Bash command is safe to re-run cannot be read off the command, so
 *    those are counted separately rather than guessed at.
 *
 * Scores are leave-one-session-out, like `policy.ts` — never the shipped
 * in-sample weights, which were fitted on these very sessions and report a third
 * as many wrong drops.
 *
 * Run: bun eval/recovery.ts [--fixture]
 */
import { loadCorpus, rowKey } from './corpus.js';
import { outOfFoldScores } from './oof.js';
import { DEFAULT_OPTIONS, decideAll, freedBy } from '../src/compact.js';
import type { CallAnswer, ToolCall } from '../src/index.js';

const { rows, from } = loadCorpus(import.meta.dirname);
const { result: resultScore, call: callScore } = outOfFoldScores(import.meta.dirname, rows);

/** Re-reading an unchanged file gives the same bytes; re-running a build does not. */
const DETERMINISTIC_READS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
type Recovery = 're-read' | 'changed since' | 'command, side effects unknown' | 'not repeatable';

function classify(tool: string, changedAfter: boolean): Recovery {
  if (changedAfter) return 'changed since';
  if (DETERMINISTIC_READS.has(tool)) return 're-read';
  if (tool === 'Bash') return 'command, side effects unknown';
  return 'not repeatable';
}

interface Loss { tool: string; chars: number; left: 'nothing' | 'head' | 'all of it'; recovery: Recovery; evidence: string }
const losses: Loss[] = [];
let needed = 0;
const sessions = [...new Set(rows.map((r) => r.session))];

for (const session of sessions) {
  const inSession = rows.filter((row) => row.session === session);
  const calls: ToolCall[] = inSession.map((row) => ({
    id: rowKey(row), tool_use_id: rowKey(row), tool: row.tool, input: {},
    callIndex: 0, resultIndex: 1, resultText: '', resultChars: row.output_chars,
    isError: row.is_error, pinned: false,
  }));
  const answers = new Map<string, CallAnswer>(inSession.map((row) => [
    rowKey(row),
    { keepResult: resultScore.get(rowKey(row))!, keepCall: callScore.get(rowKey(row))! },
  ]));
  const actions = new Map(decideAll(calls, answers, DEFAULT_OPTIONS).map((d) => [d.id, d.action]));
  const byId = new Map(calls.map((call) => [call.id, call]));
  for (const row of inSession) {
    if (!row.result_needed) continue;
    needed += 1;
    const action = actions.get(rowKey(row));
    if (action === undefined || action === 'keep') continue;
    // A result short enough to fit in the head is not shortened at all, so being
    // "dropped" costs nothing. Counting those as losses overstates the damage.
    const removed = freedBy(byId.get(rowKey(row))!, action, DEFAULT_OPTIONS.truncateHeadChars);
    if (removed === 0) continue;
    losses.push({
      tool: row.tool,
      chars: row.output_chars,
      left: action === 'drop_call' ? 'nothing' : 'head',
      recovery: classify(row.tool, row.state.includes('changed afterwards')),
      evidence: row.evidence.replace(/ \(\d+ shingles\)/, ''),
    });
  }
}

const pct = (n: number, d: number): string => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;
console.log(`${from}: ${rows.length} calls in ${sessions.length} sessions, ${needed} reused later\n`);
console.log(`dropped anyway: ${losses.length} (${pct(losses.length, needed)} of the reused outputs)`);
console.log(`per session:    ${(losses.length / sessions.length).toFixed(2)} outputs`);
console.log(`of those, kept their first ${DEFAULT_OPTIONS.truncateHeadChars} characters: ` +
  `${losses.filter((l) => l.left === 'head').length}, lost entirely: ` +
  `${losses.filter((l) => l.left === 'nothing').length}\n`);

const table = (title: string, key: (l: Loss) => string): void => {
  console.log(title);
  const groups = new Map<string, Loss[]>();
  for (const loss of losses) groups.set(key(loss), [...(groups.get(key(loss)) ?? []), loss]);
  for (const [name, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${name.padEnd(32)}${String(group.length).padStart(3)}` +
      `${group.reduce((s, l) => s + l.chars, 0).toLocaleString().padStart(12)} chars`);
  }
  console.log();
};
table('how the assistant would get it back:', (l) => l.recovery);
table('which tool produced it:', (l) => l.tool);
table('why it was needed:', (l) => l.evidence);

const unrecoverable = losses.filter((l) => l.recovery !== 're-read' && l.left !== 'head');
console.log(`Not recoverable by re-running, and no head left: ${unrecoverable.length} ` +
  `of ${rows.length} calls (${pct(unrecoverable.length, rows.length)}), ` +
  `${(unrecoverable.length / sessions.length).toFixed(2)} per session.`);
console.log('NOT measured here: whether an assistant given the compacted transcript still');
console.log('finishes the task. That needs a live A/B and is listed as unverified.');
