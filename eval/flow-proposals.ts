/**
 * Study 4 — can kompact reliably find/offer skill proposals for full flows?
 *
 * A "full flow" is a re-usable multi-step tool sequence (Read -> Edit -> test),
 * plus the session-start `orient` reads and the pre-handback `verify` checks. The
 * honesty ledger marks "whether a proposed skill is worth having" as NOT verified,
 * and its counter-evidence was generic shell verbs topping the list. This asks the
 * narrower, answerable question: of the flows kompact would surface, how many are
 * *reliable* — a habit across sessions, not one afternoon's accident, and
 * actionable rather than pure inspection?
 *
 * Mines flows exactly as the shipped recorder does (hooks/kompact-signals.ts):
 * 3-step sliding window kept only when `isSequenceWorthKeeping`, first batch as
 * `orient`, last as `verify`. Then scores reliability:
 *   - recurrence: distinct sessions the signature appears in (>=2 = a habit)
 *   - actionable: contains a step that changes or runs something (Edit/Write/... or
 *     a Bash program that is not pure inspection) rather than only reading
 *
 * Compares the current ranking (estimateSaved, what propose.ts shows) against a
 * gated ranking (require recurrence>=2 AND actionable). Reports precision@N and the
 * count of genuinely re-usable flows. Signatures are safe shapes; no samples, no
 * raw prompts, ever.
 *
 * Run: bun eval/flow-proposals.ts [--sessions 40] [--write] [--self-check]
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type Aggregate, type Row, bump } from '../hooks/kompact-signals.js';
import { isSequenceWorthKeeping, sequenceSignature, estimateSaved } from '../src/signals.js';
import { collectToolCalls } from '../src/state.js';
import { readTranscript } from './transcript.js';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const LIMIT = Number(flag('--sessions') ?? 300);
const FLOW_KINDS = new Set(['sequence', 'orient', 'verify']);
const TOPN = 20;

/** Programs that only look at state; a flow of only these needs no skill. */
const INSPECTION_PROGS = new Set([
  'grep', 'sed', 'ls', 'cat', 'find', 'head', 'tail', 'wc', 'pwd', 'rg', 'awk', 'echo', 'cd', 'which',
]);
const INSPECTION_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'NotebookRead']);

/** Whether a Bash family (program [+subcommand]) only inspects state. */
function bashInspection(inner: string): boolean {
  const t = inner.trim().split(/\s+/);
  const prog = t[0] ?? '';
  if (prog === 'git') return ['status', 'diff', 'log', 'show'].includes(t[1] ?? '');
  return INSPECTION_PROGS.has(prog);
}

/** A flow is actionable if any step edits, writes, or runs something non-trivial. */
export function isActionable(sig: string): boolean {
  return sig.split(' → ').some((step) => {
    const m = /^Bash\((.*)\)$/.exec(step);
    if (m) return !bashInspection(m[1]!);          // a real command, not inspection
    return !INSPECTION_TOOLS.has(step);            // Edit/Write/Task/... = action
  });
}

function sessionFiles(root: string, limit: number): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      try { if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.jsonl')) files.push(p); } catch { /* skip */ }
    }
  };
  walk(root); // recursive: includes <session>/subagents/agent-*.jsonl, missed before
  return files.map((path) => ({ path, size: statSync(path).size }))
    .sort((a, b) => b.size - a.size).slice(0, limit).map((x) => x.path);
}

/** Session identity = the PARENT session, so many subagents of one session do not
 *  fake cross-session recurrence. A subagent path is <parent>/subagents/agent-*.jsonl. */
function parentSession(path: string): string {
  const m = /([^/]+)\/subagents\/[^/]+\.jsonl$/.exec(path);
  if (m) return m[1]!.slice(0, 8);
  return path.split('/').pop()!.replace(/\.jsonl$/, '').slice(0, 8);
}

/** Mirrors the recorder's flow extraction (hooks/kompact-signals.ts replay). */
export function replayFlows(rows: Aggregate, path: string, session: string): void {
  const messages = readTranscript(path);
  const calls = collectToolCalls(messages, 0);
  const batches = new Map<number, typeof calls>();
  for (const call of calls) batches.set(call.callIndex, [...(batches.get(call.callIndex) ?? []), call]);
  const recent: Array<{ tool: string; command?: string }> = [];
  let seen = 0, lastSequence = '', at = 0;
  for (const [index] of messages.entries()) {
    at += 1000;
    const batch = batches.get(index);
    if (!batch) continue;
    const steps = batch.map((call) => {
      const command = (call.input as { command?: unknown }).command;
      return typeof command === 'string' ? { tool: call.tool, command } : { tool: call.tool };
    });
    recent.push(...steps);
    while (recent.length > 3) recent.shift();
    if (recent.length === 3 && isSequenceWorthKeeping(recent)) {
      bump(rows, 'sequence', sequenceSignature(recent), '', session, 3, 0, at);
    }
    const sequence = sequenceSignature(steps);
    if (seen === 0 && steps.length > 0) bump(rows, 'orient', sequence, '', session, steps.length, 0, at);
    seen += 1;
    lastSequence = sequence;
  }
  if (lastSequence) bump(rows, 'verify', lastSequence, '', session, 0, 0, at);
}

type Flow = Row & { sig: string; saved: number; sessionsN: number; actionable: boolean; reliable: boolean };

function toFlows(rows: Aggregate): Flow[] {
  const out: Flow[] = [];
  for (const [key, row] of Object.entries(rows)) {
    if (!FLOW_KINDS.has(row.kind)) continue;
    const sig = key.slice(key.indexOf('::') + 2);
    const sessionsN = row.sessions.length;
    const actionable = isActionable(sig);
    out.push({
      ...row, sig, saved: estimateSaved(row.n, row.calls, row.chars),
      sessionsN, actionable, reliable: sessionsN >= 2 && actionable,
    });
  }
  return out;
}

function main() {
  const rows: Aggregate = {};
  const files = sessionFiles(join(homedir(), '.claude', 'projects'), LIMIT);
  let sessions = 0;
  for (const path of files) {
    try { replayFlows(rows, path, parentSession(path)); sessions += 1; }
    catch { /* skip unreadable */ }
  }
  const flows = toFlows(rows);
  if (flows.length === 0) { console.log('no flows found'); return; }

  const crossSession = flows.filter((f) => f.sessionsN >= 2);
  const reliable = flows.filter((f) => f.reliable);
  // current ranking: what propose.ts surfaces, by modelled saved.
  const bySaved = [...flows].sort((a, b) => b.saved - a.saved);
  const topN = bySaved.slice(0, TOPN);
  const precCross = topN.filter((f) => f.sessionsN >= 2).length / topN.length;
  const precReliable = topN.filter((f) => f.reliable).length / topN.length;
  // gated ranking: require reliable, then by saved.
  const gated = reliable.sort((a, b) => b.saved - a.saved);

  const fixture = {
    sessions,
    flowSignatures: flows.length,
    crossSessionFlows: crossSession.length,
    crossSessionPct: Number((100 * crossSession.length / flows.length).toFixed(1)),
    reliableFlows: reliable.length,
    reliablePct: Number((100 * reliable.length / flows.length).toFixed(1)),
    currentTopNPrecisionCrossSession: Number((100 * precCross).toFixed(0)),
    currentTopNPrecisionReliable: Number((100 * precReliable).toFixed(0)),
    topReliable: gated.slice(0, 10).map((f) => ({ sig: f.sig, kind: f.kind, sessions: f.sessionsN, n: f.n })),
  };

  console.log(`\nsessions replayed:        ${fixture.sessions}`);
  console.log(`distinct flow shapes:     ${fixture.flowSignatures}`);
  console.log(`recur across >=2 sessions:${String(fixture.crossSessionFlows).padStart(5)}  (${fixture.crossSessionPct}%)  <- a habit, not one afternoon`);
  console.log(`reliable (>=2 sess + actionable): ${fixture.reliableFlows}  (${fixture.reliablePct}%)`);
  console.log(`\ncurrent ranking (by saved), top ${TOPN}:`);
  console.log(`  cross-session: ${fixture.currentTopNPrecisionCrossSession}%   reliable (+actionable): ${fixture.currentTopNPrecisionReliable}%`);
  console.log(`\ntop reliable flows a skill could cover:`);
  for (const f of fixture.topReliable) {
    console.log(`  [${f.kind}] ${f.sig.slice(0, 60).padEnd(62)} ${f.sessions} sess, ${f.n}x`);
  }
  const verdict = fixture.reliableFlows >= 3 && fixture.currentTopNPrecisionReliable < 60
    ? 'PROMISING but needs the gate: reliable flows exist, yet the current saved-ranking surfaces mostly one-off/inspection noise. Gate on (>=2 sessions AND actionable).'
    : fixture.reliableFlows >= 3
      ? 'RELIABLE: enough cross-session actionable flows, and the ranking already surfaces them.'
      : 'WEAK: too few flows recur across sessions on this corpus to propose reliably.';
  console.log(`\nverdict: ${verdict}`);
  console.log(`(Unchanged caveat, per the ledger: this measures that a flow recurs, not that turning it into a skill saves time.)`);

  if (args.includes('--write')) {
    const out = join(import.meta.dirname, 'fixtures', 'flow-proposals.json');
    writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`\nwrote ${out}`);
  }
}

/** ponytail: self-check on actionability + reliability gate, no corpus. */
function selfCheck() {
  if (isActionable('Read → Grep → Bash(git status)')) throw new Error('all-inspection flow must be non-actionable');
  if (isActionable('Bash(grep -n) → Bash(sed -n) → Bash(sed -n)')) throw new Error('grep/sed chain must be non-actionable');
  if (!isActionable('Read → Edit → Bash(npm test)')) throw new Error('edit+test flow must be actionable');
  if (!isActionable('Grep → Bash(git commit)')) throw new Error('a real command must be actionable');
  const rows: Aggregate = {};
  bump(rows, 'sequence', 'Read → Edit → Bash(npm test)', '', 's1', 3, 0, 1);
  bump(rows, 'sequence', 'Read → Edit → Bash(npm test)', '', 's2', 3, 0, 2);
  bump(rows, 'sequence', 'Read → Glob → Grep', '', 's1', 3, 0, 3);
  const flows = toFlows(rows);
  const good = flows.find((f) => f.sig.includes('npm test'));
  const insp = flows.find((f) => f.sig.includes('Glob'));
  if (!good?.reliable) throw new Error('2-session actionable flow must be reliable');
  if (insp?.reliable) throw new Error('1-session inspection flow must not be reliable');
}

/**
 * Accumulation curve: does the reliable-flow count keep rising as sessions pile
 * up, or saturate early? Replays sessions OLDEST-first and, after each, counts
 * reliable flows (>=2 sessions AND actionable) using only the sessions seen so
 * far. A curve still climbing at the end means the feature compounds with use.
 */
function curve() {
  const root = join(homedir(), '.claude', 'projects');
  const files = (function all(): { path: string; m: number }[] {
    const out: { path: string; m: number }[] = [];
    if (!existsSync(root)) return out;
    for (const project of readdirSync(root)) {
      const dir = join(root, project);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      for (const name of readdirSync(dir)) if (name.endsWith('.jsonl')) {
        const p = join(dir, name);
        out.push({ path: p, m: statSync(p).mtimeMs });
      }
    }
    return out;
  })().sort((a, b) => a.m - b.m).slice(-45); // oldest-first, the active cluster
  const rows: Aggregate = {};
  console.log(`\nsessions  cross≥2  reliable  new-reliable`);
  let prev = 0; let k = 0;
  for (const { path } of files) {
    k += 1;
    try { replayFlows(rows, path, path.split('/').pop()!.slice(0, 8)); } catch { continue; }
    if (k % 3 !== 0 && k !== files.length) continue;
    const flows = toFlows(rows);
    const cross = flows.filter((fl) => fl.sessionsN >= 2).length;
    const reliable = flows.filter((fl) => fl.reliable).length;
    console.log(`${String(k).padStart(6)}  ${String(cross).padStart(6)}  ${String(reliable).padStart(8)}  ${String(reliable - prev).padStart(11)}`);
    prev = reliable;
  }
  console.log(`\nIf 'reliable' is still climbing at ${files.length} sessions, more history keeps surfacing`);
  console.log(`skill-worthy flows; if it flattened, the useful set is already found.`);
}

selfCheck();
if (args.includes('--self-check')) console.log('self-check ok');
else if (args.includes('--curve')) curve();
else main();
