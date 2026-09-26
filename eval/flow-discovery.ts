/**
 * Study 5 — does a better discovery method find flows the fixed 3-gram misses?
 *
 * Study 4 found near-zero cross-session recurrence with rigid contiguous 3-grams
 * over tool types. Two model-free upgrades test whether that was the method's
 * fault or the truth:
 *
 *   1. PrefixSpan — frequent *gapped, variable-length* subsequences across
 *      sessions (Pei et al.). Catches `Edit ... test ... commit` through noise,
 *      which a contiguous 3-gram cannot. Model-free.
 *   2. Intent-anchored flows — group the tool flow that FOLLOWS each recurring
 *      user intent (reusing kompact's own `intentSignature`), so a flow is keyed
 *      by the goal it serves, not the tool syntax. Directly tests "diverse work
 *      shares nothing" at the goal level rather than the syntax level.
 *
 * Compared against Study 4's baseline (33 cross-session / 25 reliable). Heavier
 * methods (PAM, Local Process Models, LLM auto-skill) are escalated only if these
 * two show a signal. Scrubbed aggregate fixture; signatures are safe shapes, and
 * intents are already-redacted keyword shapes, never raw prompts.
 *
 * Run: bun eval/flow-discovery.ts [--sessions 150] [--write] [--self-check]
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { intentSignature, isCorrection, sequenceSignature } from '../src/signals.js';
import { collectToolCalls } from '../src/state.js';
import { readTranscript } from './transcript.js';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const LIMIT = Number(flag('--sessions') ?? 400);
const MIN_SESSIONS = 3;   // a pattern must span >=3 sessions (>=2 explodes on a thin corpus)
const MAX_LEN = 4;        // longest pattern PrefixSpan grows
const MAX_SEQ = 300;      // ponytail: cap a session's step list to bound PrefixSpan
const MIN_CALLS = 10;     // a 'substantial' session; most transcripts have almost none

// mirrors flow-proposals.ts isActionable (eval study code; a small dup, not shipped).
const INSPECTION_PROGS = new Set(['grep','sed','ls','cat','find','head','tail','wc','pwd','rg','awk','echo','cd','which']);
const INSPECTION_TOOLS = new Set(['Read','Glob','Grep','LS','TodoWrite','NotebookRead']);
function stepInspects(step: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(step);
  if (m) { const t = m[1]!.trim().split(/\s+/); return t[0] === 'git' ? ['status','diff','log','show'].includes(t[1] ?? '') : INSPECTION_PROGS.has(t[0] ?? ''); }
  return INSPECTION_TOOLS.has(step);
}
const actionable = (pattern: readonly string[]): boolean => pattern.some((s) => !stepInspects(s));

function sessionFiles(root: string, limit: number): string[] {
  if (!existsSync(root)) return [];
  const files: { path: string; size: number }[] = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      try { if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.jsonl')) files.push({ path: p, size: statSync(p).size }); } catch { /* skip */ }
    }
  };
  walk(root); // recursive: includes <session>/subagents/agent-*.jsonl
  return files.sort((a, b) => b.size - a.size).slice(0, limit).map((x) => x.path);
}

/** Parent session id, so subagents group under their session, not fake recurrence. */
function parentSession(path: string): string {
  const m = /([^/]+)\/subagents\/[^/]+\.jsonl$/.exec(path);
  if (m) return m[1]!.slice(0, 8);
  return path.split('/').pop()!.replace(/\.jsonl$/, '').slice(0, 8);
}

/** One session -> its ordered tool-step tokens (immediate repeats collapsed). */
function stepsOf(path: string): string[] {
  const messages = readTranscript(path);
  const calls = collectToolCalls(messages, 0);
  const byMsg = new Map<number, typeof calls>();
  for (const c of calls) byMsg.set(c.callIndex, [...(byMsg.get(c.callIndex) ?? []), c]);
  const toks: string[] = [];
  for (const [, batch] of [...byMsg.entries()].sort((a, b) => a[0] - b[0])) {
    for (const c of batch) {
      const cmd = (c.input as { command?: unknown }).command;
      const step = sequenceSignature([typeof cmd === 'string' ? { tool: c.tool, command: cmd } : { tool: c.tool }]);
      if (toks[toks.length - 1] !== step) toks.push(step);  // collapse immediate runs
    }
  }
  return toks.slice(0, MAX_SEQ);
}

/** Intent -> the flow (>=2 steps) that followed it, per session. */
function intentFlows(path: string): { intent: string; flow: string }[] {
  const messages = readTranscript(path);
  const calls = collectToolCalls(messages, 0);
  const byMsg = new Map<number, typeof calls>();
  for (const c of calls) byMsg.set(c.callIndex, [...(byMsg.get(c.callIndex) ?? []), c]);
  const out: { intent: string; flow: string }[] = [];
  let curIntent = ''; let cur: string[] = [];
  const flush = () => {
    if (curIntent && cur.length >= 2) out.push({ intent: curIntent, flow: cur.join(' → ') });
    cur = [];
  };
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.text.trim() && m.toolResults === undefined && !isCorrection(m.text)) {
      flush(); curIntent = intentSignature(m.text); return;
    }
    for (const c of (byMsg.get(i) ?? [])) {
      const cmd = (c.input as { command?: unknown }).command;
      const step = sequenceSignature([typeof cmd === 'string' ? { tool: c.tool, command: cmd } : { tool: c.tool }]);
      if (cur[cur.length - 1] !== step) cur.push(step);
    }
  });
  flush();
  return out;
}

/** PrefixSpan: subsequences present (as a subsequence) in >= minsup sequences. */
export function prefixSpan(db: readonly (readonly string[])[], minsup: number, maxLen: number):
    { pattern: string[]; support: number }[] {
  const out: { pattern: string[]; support: number }[] = [];
  // project: for each sequence, the suffix after the first occurrence of `item`.
  const grow = (prefix: string[], projected: readonly (readonly string[])[]): number[] => {
    if (prefix.length >= maxLen) return [];
    const counts = new Map<string, number>();
    for (const seq of projected) {
      for (const item of new Set(seq)) counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    for (const [item, support] of counts) {
      if (support < minsup) continue;
      const pattern = [...prefix, item];
      const next: string[][] = [];
      for (const seq of projected) {
        const idx = seq.indexOf(item);
        if (idx >= 0) next.push(seq.slice(idx + 1));
      }
      const childSupports = grow(pattern, next);
      // closed: keep only if no single-item extension has the SAME support
      // (an equal-support prefix is redundant — it always co-occurs).
      if (!childSupports.some((c) => c === support)) out.push({ pattern, support });
    }
    return [...counts.values()];
  };
  grow([], db);
  return out;
}

/** a is a subsequence of b (order-preserving, gaps allowed). */
function isSubseq(a: readonly string[], b: readonly string[]): boolean {
  let i = 0;
  for (const x of b) { if (i < a.length && a[i] === x) i += 1; }
  return i === a.length;
}
/** Keep only maximal patterns: no other pattern is a supersequence with >= support. */
function maximal(pats: { pattern: string[]; support: number }[]): { pattern: string[]; support: number }[] {
  return pats.filter((p) => !pats.some((q) =>
    q !== p && q.pattern.length > p.pattern.length && q.support >= p.support && isSubseq(p.pattern, q.pattern)));
}

function main() {
  const paths = sessionFiles(join(homedir(), '.claude', 'projects'), LIMIT);
  const byParent = new Map<string, string[]>();        // parent -> concatenated steps
  const intentMap = new Map<string, Map<string, Set<string>>>(); // intent -> flow -> parents
  let total = 0;
  for (const path of paths) {
    total += 1;
    const parent = parentSession(path);
    try {
      const toks = stepsOf(path);
      if (toks.length) byParent.set(parent, [...(byParent.get(parent) ?? []), ...toks]);
      for (const { intent, flow } of intentFlows(path)) {
        if (!intent) continue;
        const byFlow = intentMap.get(intent) ?? new Map<string, Set<string>>();
        (byFlow.get(flow) ?? byFlow.set(flow, new Set()).get(flow)!).add(parent);
        intentMap.set(intent, byFlow);
      }
    } catch { /* skip */ }
  }
  const db: string[][] = [...byParent.values()].filter((seq) => seq.length >= MIN_CALLS).map((seq) => seq.slice(0, MAX_SEQ));
  const sessions = db.length;

  // PrefixSpan patterns of length >=2, cross-session, actionable.
  const patterns = prefixSpan(db, MIN_SESSIONS, MAX_LEN)
    .filter((p) => p.pattern.length >= 2);
  const crossSession = patterns.length;
  const actionablePatterns = patterns.filter((p) => actionable(p.pattern));
  const longGapped = actionablePatterns.filter((p) => p.pattern.length >= 3);
  const maximalActionable = maximal(actionablePatterns);
  const topPatterns = [...actionablePatterns].sort((a, b) => b.support - a.support || b.pattern.length - a.pattern.length).slice(0, 12);

  // Intent-anchored: recurring intents (>=2 sessions) that map to a consistent flow.
  let recurringIntents = 0, intentsWithStableFlow = 0;
  const goalFlows: { intent: string; flow: string; sessions: number }[] = [];
  for (const [intent, byFlow] of intentMap) {
    const sessionsForIntent = new Set<string>();
    for (const s of byFlow.values()) for (const x of s) sessionsForIntent.add(x);
    if (sessionsForIntent.size < 2) continue;
    recurringIntents += 1;
    // the most common flow for this intent, and whether it spans >=2 sessions.
    const best = [...byFlow.entries()].sort((a, b) => b[1].size - a[1].size)[0]!;
    if (best[1].size >= 2 && actionable(best[0].split(' → '))) {
      intentsWithStableFlow += 1;
      goalFlows.push({ intent, flow: best[0], sessions: best[1].size });
    }
  }

  const fixture = {
    substantialSessions: sessions,
    totalTranscripts: total,
    totalParentSessions: byParent.size,
    prefixspanMaximalActionable: maximalActionable.length,
    // PrefixSpan vs the n-gram baseline (Study 4: 33 cross-session, 25 reliable).
    prefixspanCrossSessionPatterns: crossSession,
    prefixspanActionable: actionablePatterns.length,
    prefixspanLongActionable: longGapped.length,
    ngramBaselineCrossSession: 33,
    ngramBaselineReliable: 25,
    // Intent-anchored.
    recurringIntents,
    intentsWithStableActionableFlow: intentsWithStableFlow,
    topPatterns: topPatterns.map((p) => ({ flow: p.pattern.join(' → '), support: p.support })),
    topGoalFlows: goalFlows.sort((a, b) => b.sessions - a.sessions).slice(0, 8),
  };

  console.log(`\ndistinct PARENT sessions: ${fixture.totalParentSessions}   substantial (>=${MIN_CALLS} calls): ${fixture.substantialSessions}`);
  console.log(`(the ${fixture.totalTranscripts} transcripts group into these parents; most are subagents of a few sessions)`);
  console.log(`\n--- PrefixSpan (gapped, len<=${MAX_LEN}, >=${MIN_SESSIONS} sessions) ---`);
  console.log(`cross-session patterns (len>=2):   ${crossSession}   (n-gram baseline: ${fixture.ngramBaselineCrossSession})`);
  console.log(`  of those, actionable:            ${actionablePatterns.length}   (baseline reliable: ${fixture.ngramBaselineReliable})`);
  console.log(`  actionable AND length>=3 (gapped):${longGapped.length}`);
  console.log(`  DEDUPED to maximal (fair vs baseline): ${maximalActionable.length}   (baseline reliable: ${fixture.ngramBaselineReliable})`);
  console.log(`top actionable patterns by support:`);
  for (const p of topPatterns) console.log(`  ${String(p.support).padStart(3)}x  ${p.pattern.join(' → ').slice(0, 66)}`);
  console.log(`\n--- Intent-anchored (flow keyed by goal, not syntax) ---`);
  console.log(`recurring intents (>=2 sessions):        ${recurringIntents}`);
  console.log(`  with a stable actionable flow:         ${intentsWithStableFlow}   <- goal-anchored skill candidates`);
  for (const g of fixture.topGoalFlows) console.log(`  [${g.sessions} sess] "${g.intent.slice(0, 28)}" -> ${g.flow.slice(0, 40)}`);

  const dataLimited = fixture.substantialSessions < 12;
  const methodHelps = maximalActionable.length > fixture.ngramBaselineReliable * 2 || intentsWithStableFlow >= 5;
  console.log(`\nverdict: ${dataLimited
    ? `DATA-LIMITED: only ${fixture.substantialSessions} substantial sessions exist (most transcripts have <${MIN_CALLS} calls), and they are dominated by one project/this session. No mining method — gapped, goal-anchored, or heavier (PAM/LPM/LLM) — can reliably discover cross-operator flows from this. The binding constraint is a second operator's corpus, not the algorithm.`
    : methodHelps
      ? 'METHOD MATTERS: closed gapped / intent-anchored mining finds materially more real (de-duplicated, actionable) flows than the 3-gram; escalate to PAM/LPM/auto-skill.'
      : 'SPARSITY IS REAL: even closed gapped and goal-anchored mining find little more than the 3-gram baseline.'}`);
  console.log(`(Payoff still unverified: recurrence != a skill saves time. SkillOpt-style held-out A/B is the next test.)`);

  if (args.includes('--write')) {
    const out = join(import.meta.dirname, 'fixtures', 'flow-discovery.json');
    writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`\nwrote ${out}`);
  }
}

/** ponytail: self-check on PrefixSpan + actionability, no corpus. */
function selfCheck() {
  const db = [['Read', 'Edit', 'X', 'Bash(npm test)'], ['Read', 'Y', 'Edit', 'Bash(npm test)'], ['Read', 'Edit']];
  const pats = prefixSpan(db, 2, 4);
  const has = (p: string[]) => pats.some((q) => q.pattern.join(',') === p.join(',') && q.support >= 2);
  if (!has(['Read', 'Edit'])) throw new Error('Read,Edit should be frequent (3 sessions)');
  if (!has(['Read', 'Edit', 'Bash(npm test)'])) throw new Error('gapped Read,Edit,test should be found in 2 sessions');
  if (has(['X', 'Y'])) throw new Error('X,Y appears in <2 sessions, must be excluded');
  if (actionable(['Read', 'Grep'])) throw new Error('read/grep only must be non-actionable');
  if (!actionable(['Read', 'Bash(npm test)'])) throw new Error('a real command must be actionable');
}

selfCheck();
if (args.includes('--self-check')) console.log('self-check ok');
else main();
