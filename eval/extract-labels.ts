/**
 * Phase 3 — ground-truth labels from transcripts that already exist.
 *
 * No hand-labelling and no teacher model. The signal is behavioural: if the
 * assistant later reproduced a distinctive run of words from a tool's output —
 * in its prose, in its thinking, or (strongest of all) inside a later tool
 * input such as an Edit's `old_string` — then that output was needed verbatim
 * and re-running the tool would not have done. If instead it simply read the
 * same target again, the output was reproducible by definition.
 *
 * Run: bun eval/extract-labels.ts [outfile]
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCallState, callContexts, collectToolCalls, goalFromMessages, targetOf } from '../src/state.js';
import { readTranscript } from './transcript.js';

const PRESERVE_RECENT = 6;
const STATE_BUDGET = 700;
/** Words per shingle. Long enough that ordinary English does not collide. */
const SHINGLE = 8;
/**
 * Shingles kept per output. Stride 1 until this cap, so small and large outputs
 * are sampled the same way up to it; above it a stride thins them out and
 * `sampled_shingles` records the denominator.
 */
const MAX_SHINGLES = 2_000;
/**
 * A shingle owned by more than this many calls is boilerplate — a shell prompt,
 * a stack-trace header, a repeated log line — and matching it proves nothing.
 */
const BOILERPLATE_OWNERS = 3;
/**
 * Distinct non-boilerplate shingles that must reappear downstream. One can be
 * coincidence; two runs of eight words is reuse.
 */
const MIN_MATCHES = 2;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (entry.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [];
}

/** All shingles of a text — exhaustive, because this is the lookup side. */
function allShingles(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i += 1) out.add(w.slice(i, i + SHINGLE).join(' '));
  return out;
}

/** Shingles of an output — the side we look up; stride 1 until the cap. */
function sampledShingles(text: string): string[] {
  const w = words(text);
  const total = Math.max(0, w.length - SHINGLE + 1);
  if (total === 0) return [];
  const stride = Math.max(1, Math.ceil(total / MAX_SHINGLES));
  const out: string[] = [];
  for (let i = 0; i < total; i += stride) out.push(w.slice(i, i + SHINGLE).join(' '));
  return out;
}

export interface LabelRow {
  session: string;
  tool_use_id: string;
  tool: string;
  target: string;
  output_chars: number;
  is_error: boolean;
  /** The task still concerns this call's target. */
  call_needed: boolean;
  /** The output was reproduced verbatim later, so re-running would not have done. */
  result_needed: boolean;
  /** Distinct non-boilerplate shingles of this output that reappeared later. */
  match_shingles: number;
  /** Shingles this output contributed, the denominator for `match_shingles`. */
  sampled_shingles: number;
  evidence: string;
  /** Exactly the state production would send for this call. */
  state: string;
  state_tokens: number;
  /** Index of the message holding this call's result. */
  result_index: number;
  /** Index of the message that first reused the output verbatim; -1 if none. */
  first_reuse_index: number;
  /** Messages in the whole session. */
  messages: number;
  labeled_at: string;
}

export function labelSession(path: string, session: string, today: string): LabelRow[] {
  const messages = readTranscript(path);
  const calls = collectToolCalls(messages, PRESERVE_RECENT);
  if (calls.length === 0) return [];
  const contexts = callContexts(calls, messages.length);
  const goal = goalFromMessages(messages);

  const byResultIndex = new Map<number, typeof calls>();
  for (const call of calls) {
    const list = byResultIndex.get(call.resultIndex) ?? [];
    list.push(call);
    byResultIndex.set(call.resultIndex, list);
  }

  // Boilerplate is identified over the whole session first: a shingle many
  // different outputs share cannot evidence that any one of them was reused.
  const owners = new Map<string, number>();
  const shinglesOf = new Map<string, string[]>();
  for (const call of calls) {
    const list = sampledShingles(call.resultText);
    shinglesOf.set(call.id, list);
    for (const shingle of new Set(list)) owners.set(shingle, (owners.get(shingle) ?? 0) + 1);
  }

  // shingle -> call ids whose output contains it, populated as we pass each
  // result, so only *later* text can ever match it.
  const pending = new Map<string, Set<string>>();
  const matches = new Map<string, Set<string>>();
  const quotedBy = new Map<string, string>();
  // The message index of the first reuse. Without it "was this output needed"
  // cannot be asked *relative to a compaction point*, which is the difference
  // between recovery cost and task outcome.
  const firstReuse = new Map<string, number>();

  messages.forEach((message, index) => {
    // Look up first: a later message quoting an earlier output is the signal.
    const haystack = [
      message.text,
      ...message.toolUses.map((tool) => {
        try {
          return JSON.stringify(tool.input);
        } catch {
          return '';
        }
      }),
    ].join('\n');
    if (haystack.trim() !== '') {
      for (const shingle of allShingles(haystack)) {
        const holders = pending.get(shingle);
        if (holders === undefined) continue;
        for (const id of holders) {
          const seen = matches.get(id) ?? new Set<string>();
          seen.add(shingle);
          matches.set(id, seen);
          if (!quotedBy.has(id)) {
            quotedBy.set(id, message.toolUses.length > 0 ? 'reused in a later tool input' : 'quoted in later text');
          }
          if (!firstReuse.has(id)) firstReuse.set(id, index);
        }
      }
    }
    // Then register this message's own outputs for future messages to match,
    // skipping boilerplate shared across many calls.
    for (const call of byResultIndex.get(index) ?? []) {
      for (const shingle of shinglesOf.get(call.id) ?? []) {
        if ((owners.get(shingle) ?? 0) > BOILERPLATE_OWNERS) continue;
        const holders = pending.get(shingle) ?? new Set<string>();
        holders.add(call.id);
        pending.set(shingle, holders);
      }
    }
  });

  return calls.map((call) => {
    const context = contexts.get(call.id)!;
    const built = buildCallState(call, context, goal, STATE_BUDGET);
    const target = targetOf(call) ?? '';
    const matched = matches.get(call.id)?.size ?? 0;
    const sampled = new Set(shinglesOf.get(call.id) ?? []).size;
    const wasQuoted = matched >= MIN_MATCHES;
    const evidence = wasQuoted
      ? `${quotedBy.get(call.id)!} (${matched} shingles)`
      : context.rerunLater
        ? 'the same target was read again later, so it was reproducible'
        : 'never reproduced downstream';
    return {
      session,
      tool_use_id: call.tool_use_id,
      tool: call.tool,
      target,
      output_chars: call.resultChars,
      is_error: call.isError,
      call_needed: wasQuoted || context.rerunLater || context.targetTouchedAfter,
      result_needed: wasQuoted,
      match_shingles: matched,
      sampled_shingles: sampled,
      evidence,
      state: built.state,
      state_tokens: built.tokens,
      /** Where the call's result sits in the transcript. */
      result_index: call.resultIndex,
      /** Message index of the first verbatim reuse, or -1 if never reused. */
      first_reuse_index: firstReuse.get(call.id) ?? -1,
      /** Messages in the session, so an index can be read as a position. */
      messages: messages.length,
      labeled_at: today,
    };
  });
}

const root = join(homedir(), '.claude', 'projects');
const outfile = process.argv[2] ?? join(import.meta.dirname, 'labels.jsonl');
const today = new Date().toISOString().slice(0, 10);
const rows: LabelRow[] = [];
let sessions = 0;
for (const path of walk(root)) {
  const session = path.slice(root.length + 1).replace(/\.jsonl$/, '');
  try {
    const found = labelSession(path, session, today);
    if (found.length > 0) sessions += 1;
    rows.push(...found);
  } catch (error) {
    console.error(`skipped ${session}: ${String(error).slice(0, 120)}`);
  }
}
writeFileSync(outfile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

const pos = rows.filter((r) => r.result_needed).length;
const posCall = rows.filter((r) => r.call_needed).length;
console.log(`sessions with calls : ${sessions}`);
console.log(`labelled calls      : ${rows.length}`);
console.log(`result_needed=true  : ${pos} (${((100 * pos) / Math.max(1, rows.length)).toFixed(1)}%)`);
console.log(`call_needed=true    : ${posCall} (${((100 * posCall) / Math.max(1, rows.length)).toFixed(1)}%)`);
console.log(`written             : ${outfile}`);
const byTool = new Map<string, [number, number]>();
for (const row of rows) {
  const [n, p] = byTool.get(row.tool) ?? [0, 0];
  byTool.set(row.tool, [n + 1, p + (row.result_needed ? 1 : 0)]);
}
console.log('\nper tool (n, result_needed%)');
for (const [tool, [n, p]] of [...byTool].sort((a, b) => b[1][0] - a[1][0]).slice(0, 12)) {
  console.log(`  ${tool.padEnd(18)} ${String(n).padStart(5)}  ${((100 * p) / n).toFixed(1)}%`);
}
