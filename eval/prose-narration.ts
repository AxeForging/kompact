/**
 * The ceiling of "orphaned narration": assistant prose whose every tool call
 * kompact drops.
 *
 * kompact never touches prose today (`applyDecisions` keeps `message.text`
 * verbatim, even on a message whose tool calls it all dropped). The safest
 * possible prose drop is exactly that residue: the "Let me read X" that
 * introduced a call whose result is now gone. This measures how much window that
 * residue is worth BEFORE any drop code is written — the same discipline the
 * tool-call scorer was held to (measure, then ship only if it clears a floor).
 *
 * Scoring is the shipped local logistic (no network, no key). For each session
 * the real decision path runs (`compact()`), and the tokens of `message.text`
 * on assistant messages where every collected call was decided `drop_call` are
 * summed against the window that was scored.
 *
 * Machine-local like `eval/repetition.ts`. The fixture is a scrubbed aggregate —
 * counts and percentages, never a byte of transcript text.
 *
 * Run: bun eval/prose-narration.ts [--write]
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compact, tokensIn } from '../src/compact.js';
import { collectToolCalls, estimateTokens } from '../src/state.js';
import { FeatureAsker } from '../src/features.js';
import { readTranscript } from './transcript.js';
import type { Message, ToolCall } from '../src/index.js';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');

/** Ship Part B only if the median session clears this. Below it: a null result. */
const MEDIAN_FLOOR_PCT = 2.0;
/** A realistic pre-compaction window, in tokens; the tail of each session. */
const WINDOW_TOKENS = 700_000;
/** Same as `compact()`'s default, so collected ids/indices line up with decisions. */
const PRESERVE_RECENT = 6;
/** Newest sessions only, to bound runtime. ponytail: 40 is plenty for a median. */
const SESSIONS = 40;
/** Below this many chars a narration is a one-liner ("Let me read X"). */
const SHORT_CHARS = 200;

function walk(root: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return out; }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (path.endsWith('.jsonl')) out.push(path);
    } catch { /* a session being written can vanish mid-walk */ }
  }
  return out;
}

/** The tail of a session summing to about a window, mimicking a live context. */
function windowTail(messages: readonly Message[]): Message[] {
  const budget = WINDOW_TOKENS * 4; // ~4 chars/token
  let chars = 0;
  const out: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    const c = (m.text?.length ?? 0) +
      m.toolUses.reduce((s, t) => s + JSON.stringify(t.input ?? {}).length, 0) +
      (m.toolResults ?? []).reduce((s, r) => s + (r.text?.length ?? 0), 0);
    out.push(m);
    chars += c;
    if (chars >= budget) break;
  }
  return out.reverse();
}

/**
 * Tokens of narration orphaned by a full-drop of a message's calls. Pure, so the
 * self-check can exercise it without the scorer.
 */
export function orphanedNarration(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  action: ReadonlyMap<string, string>,
): { tokens: number; short: number; long: number } {
  const callsByMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = callsByMessage.get(call.callIndex) ?? [];
    list.push(call);
    callsByMessage.set(call.callIndex, list);
  }
  let tokens = 0, short = 0, long = 0;
  for (const [index, group] of callsByMessage) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const allDropped = group.every((c) => action.get(c.id) === 'drop_call');
    if (!allDropped) continue;
    const text = (message.text ?? '').trim();
    if (!text) continue;
    const t = estimateTokens(text);
    tokens += t;
    if (text.length < SHORT_CHARS) short += t; else long += t;
  }
  return { tokens, short, long };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main() {
  const asker = FeatureAsker.fromWeights(); // shipped weights; no calibration file
  const paths = walk(join(homedir(), '.claude', 'projects'))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, SESSIONS)
    .map((x) => x.p);

  const rows: { pct: number; toolPct: number; prosePct: number; orphan: number; window: number; short: number; standalone: number }[] = [];
  for (const path of paths) {
    let messages: Message[];
    try { messages = windowTail(readTranscript(path)); } catch { continue; }
    if (messages.length < PRESERVE_RECENT + 2) continue;
    const calls = collectToolCalls(messages, PRESERVE_RECENT);
    if (calls.length === 0) continue;
    let result;
    try { result = await compact(messages, asker, {}); } catch { continue; }
    const action = new Map(result.decisions.map((d) => [d.id, d.action]));
    const { tokens, short } = orphanedNarration(messages, calls, action);
    const window = result.stats.tokensBefore;
    if (window <= 0) continue;
    // The true prose pool: assistant text-only rows (narration/reasoning) that
    // hold no tool call. This is where prose actually lives, and the ceiling for
    // a Phase-2 extractive scorer. Riskier than the co-located drop: attributing
    // it to a dropped call is a judgement, not a fact.
    const standalone = messages.reduce((t, m) =>
      m.role === 'assistant' && m.toolUses.length === 0 && (m.text ?? '').trim()
        ? t + estimateTokens(m.text) : t, 0);
    const toolChars = messages.reduce((s, m) =>
      s + m.toolUses.reduce((a, t) => a + JSON.stringify(t.input ?? {}).length, 0) +
      (m.toolResults ?? []).reduce((a, r) => a + (r.text?.length ?? 0), 0), 0);
    rows.push({
      pct: (100 * tokens) / window,
      toolPct: (100 * tokensIn(toolChars)) / window,
      prosePct: (100 * standalone) / window,
      orphan: tokens, window, short, standalone,
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  if (rows.length === 0) { console.log('no sessions measured'); return; }
  const pcts = rows.map((r) => r.pct);
  const totalOrphan = rows.reduce((s, r) => s + r.orphan, 0);
  const totalWindow = rows.reduce((s, r) => s + r.window, 0);
  const totalShort = rows.reduce((s, r) => s + r.short, 0);
  const med = median(pcts);
  const prosePcts = rows.map((r) => r.prosePct);
  const fixture = {
    sessions: rows.length,
    windowTokens: WINDOW_TOKENS,
    // The Phase-1 safe target: prose co-located with a fully-dropped call.
    // Structurally ~0 in Claude Code, whose tool-call messages carry no text.
    medianOrphanPct: Number(med.toFixed(2)),
    maxOrphanPct: Number(Math.max(...pcts).toFixed(2)),
    // The true prose pool: standalone assistant text rows. The Phase-2 ceiling.
    medianStandaloneProsePct: Number(median(prosePcts).toFixed(2)),
    meanStandaloneProsePct: Number((prosePcts.reduce((a, b) => a + b, 0) / rows.length).toFixed(2)),
    maxStandaloneProsePct: Number(Math.max(...prosePcts).toFixed(2)),
    medianToolPct: Number(median(rows.map((r) => r.toolPct)).toFixed(1)),
    totalOrphanTokens: totalOrphan,
    totalWindowTokens: totalWindow,
  };

  console.log(`\nsessions measured:        ${fixture.sessions}`);
  console.log(`co-located narration:     median ${fixture.medianOrphanPct}% (max ${fixture.maxOrphanPct}%)  <- Phase-1 safe target`);
  console.log(`standalone prose pool:    median ${fixture.medianStandaloneProsePct}% (mean ${fixture.meanStandaloneProsePct}%, max ${fixture.maxStandaloneProsePct}%)  <- Phase-2 ceiling`);
  console.log(`tool share of window:     median ${fixture.medianToolPct}%`);
  console.log(`pooled orphan:            ${totalOrphan.toLocaleString()} / ${totalWindow.toLocaleString()} tokens`);
  console.log(`\ngate (Phase-1): median ${fixture.medianOrphanPct}% ${med >= MEDIAN_FLOOR_PCT ? '>=' : '<'} ${MEDIAN_FLOOR_PCT}% floor -> ${med >= MEDIAN_FLOOR_PCT ? 'SHIP Part B' : 'NULL RESULT, do not ship the co-located drop'}`);
  void totalShort;

  if (WRITE) {
    const out = join(import.meta.dirname, 'fixtures', 'prose-narration.json');
    writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`\nwrote ${out}`);
  }
}

/** ponytail: one self-check on the counting logic, no scorer, no network. */
function selfCheck() {
  const messages: Message[] = [
    { role: 'user', text: 'start', toolUses: [] }, // index 0 is pinned; keep it callless
    { role: 'assistant', text: 'Let me read the config and the tests.',
      toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }, { tool_use_id: 'u2', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [],
      toolResults: [{ tool_use_id: 'u1', text: 'a' }, { tool_use_id: 'u2', text: 'b' }] },
    { role: 'assistant', text: 'Keeping this one.',
      toolUses: [{ tool_use_id: 'u3', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u3', text: 'c' }] },
    { role: 'assistant', text: 'Mixed message.',
      toolUses: [{ tool_use_id: 'u4', tool: 'Read', input: {} }, { tool_use_id: 'u5', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [],
      toolResults: [{ tool_use_id: 'u4', text: 'd' }, { tool_use_id: 'u5', text: 'e' }] },
  ];
  const calls = collectToolCalls(messages, 0);
  const byUse = new Map(calls.map((c) => [c.tool_use_id, c.id]));
  const action = new Map<string, string>([
    [byUse.get('u1')!, 'drop_call'], [byUse.get('u2')!, 'drop_call'], // msg1: all dropped -> orphaned
    [byUse.get('u3')!, 'keep'],                                       // msg3: kept -> not orphaned
    [byUse.get('u4')!, 'drop_call'], [byUse.get('u5')!, 'keep'],      // msg5: mixed -> not orphaned
  ]);
  const got = orphanedNarration(messages, calls, action);
  const want = estimateTokens('Let me read the config and the tests.');
  if (got.tokens !== want) throw new Error(`orphanedNarration: got ${got.tokens}, want ${want}`);
  if (got.short !== want || got.long !== 0) throw new Error(`short/long split wrong: ${got.short}/${got.long}`);
}

selfCheck();
if (args.includes('--self-check')) { console.log('self-check ok'); }
else { await main(); }
