/**
 * Study 16 — does the shipped scorer transfer to a DIFFERENT harness (Codex CLI)?
 *
 * Every study so far runs on one operator's Claude Code sessions. The recurring
 * conclusion (Studies 11-15) is that the lever is a second corpus, not method. The
 * closest genuinely-different distribution on this machine is `~/.codex/sessions`:
 * Codex CLI rollouts, a different harness with different tools (exec_command,
 * apply_patch) — exactly the client jev-compact targets. This scores those sessions
 * with the SHIPPED weights (no refit) and asks whether the freed@retention holds.
 *
 * Codex tools are mapped onto kompact's categories, outputs are reuse-labelled with
 * the same 8-word-shingle method as eval/extract-labels.ts, and features come from
 * the real pipeline (callContexts + buildCallState + featureVector). Small sample
 * (~100 calls, 7 sessions) — directional, not definitive; reported with that caveat.
 *
 * Reproducible only where ~/.codex exists (this is exploration, not CI). No refit,
 * no network. Run: bun eval/codex-transfer.ts
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { callContexts, buildCallState, MUTATING, UNREPEATABLE } from '../src/state.js';
import { featureVector, score, KEEP_RESULT_WEIGHTS, KEEP_CALL_WEIGHTS } from '../src/features.js';
import { auc } from './metrics.js';
import type { ToolCall } from '../src/types.js';

const SHINGLE = 8, BOILER = 3;
const words = (t: string) => (t.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
function shingles(t: string): Set<string> {
  const w = words(t); const s = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i += 1) s.add(w.slice(i, i + SHINGLE).join(' '));
  return s;
}
const mapTool = (name: string): string =>
  name === 'apply_patch' ? 'Edit'
    : name === 'view_image' ? 'Read'
      : 'Bash'; // exec_command, write_stdin, custom tools -> shell-like

function textOf(output: unknown): { text: string; isError: boolean } {
  if (typeof output !== 'string') return { text: JSON.stringify(output ?? ''), isError: false };
  try {
    const o = JSON.parse(output) as { output?: string; metadata?: { exit_code?: number } };
    if (o && typeof o === 'object' && 'output' in o) {
      return { text: String(o.output ?? ''), isError: (o.metadata?.exit_code ?? 0) !== 0 };
    }
  } catch { /* plain string */ }
  return { text: output, isError: /error|traceback|exit code [1-9]/i.test(output) };
}

interface Row { session: string; tool: string; chars: number; isError: boolean; needed: boolean; feats: number[] }

function labelSession(path: string, session: string): Row[] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  // Ordered stream: tool calls (with args), their outputs, and message texts.
  const calls: { call_id: string; name: string; args: string; idx: number }[] = [];
  const outputs = new Map<string, string>();
  const errors = new Map<string, boolean>();
  const stream: { idx: number; kind: 'msg' | 'args' | 'out'; text: string; call_id?: string }[] = [];
  let idx = 0;
  for (const line of lines) {
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload ?? {};
    if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      const args = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.input ?? p.arguments ?? '');
      calls.push({ call_id: p.call_id, name: p.name, args, idx });
      stream.push({ idx, kind: 'args', text: args }); idx += 1;
    } else if (o.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      const { text, isError } = textOf(p.output);
      outputs.set(p.call_id, text); errors.set(p.call_id, isError);
      stream.push({ idx, kind: 'out', text, call_id: p.call_id }); idx += 1;
    } else if (o.type === 'response_item' && p.type === 'message') {
      const c = Array.isArray(p.content) ? p.content.map((x: any) => x.text ?? '').join(' ') : String(p.content ?? '');
      stream.push({ idx, kind: 'msg', text: c }); idx += 1;
    } else if (o.type === 'event_msg' && (p.type === 'agent_message' || p.type === 'user_message')) {
      stream.push({ idx, kind: 'msg', text: String(p.message ?? p.text ?? '') }); idx += 1;
    }
  }
  if (calls.length === 0) return [];
  // Boilerplate owners over this session's outputs.
  const owners = new Map<string, number>();
  const outShingles = new Map<string, Set<string>>();
  for (const c of calls) {
    const sh = shingles(outputs.get(c.call_id) ?? ''); outShingles.set(c.call_id, sh);
    for (const s of sh) owners.set(s, (owners.get(s) ?? 0) + 1);
  }
  // Build ToolCall[] for the feature pipeline.
  const outIdx = new Map<string, number>();
  stream.forEach((it) => { if (it.kind === 'out' && it.call_id) outIdx.set(it.call_id, it.idx); });
  const toolCalls: ToolCall[] = calls.map((c, i) => {
    const tool = mapTool(c.name);
    const target = tool === 'Edit' ? { file_path: c.args.slice(0, 80) } : { command: c.args.slice(0, 80) };
    const out = outputs.get(c.call_id) ?? '';
    return {
      id: `t${i}`, tool_use_id: c.call_id, tool, input: target, callIndex: c.idx,
      resultIndex: outIdx.get(c.call_id) ?? c.idx + 1, resultText: out, resultChars: out.length,
      isError: errors.get(c.call_id) ?? false, pinned: false,
    };
  });
  const ctx = callContexts(toolCalls, stream.length);
  const rows: Row[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i]!; const tc = toolCalls[i]!;
    // reuse: a non-boilerplate output shingle reappearing in LATER messages or tool args.
    const later = stream.filter((it) => it.idx > (outIdx.get(c.call_id) ?? c.idx) && it.kind !== 'out')
      .map((it) => it.text).join('\n');
    const laterSh = shingles(later);
    let needed = false;
    for (const s of outShingles.get(c.call_id) ?? []) {
      if ((owners.get(s) ?? 0) <= BOILER && laterSh.has(s)) { needed = true; break; }
    }
    const stateText = buildCallState(tc, ctx.get(tc.id)!, 'complete the task', 768).state;
    rows.push({
      session, tool: tc.tool, chars: tc.resultChars, isError: tc.isError, needed,
      feats: featureVector(stateText, tc.tool, tc.isError),
    });
  }
  return rows;
}

function realize(keep: (i: number) => boolean, needed: boolean[], chars: number[], forced: boolean[]) {
  const totN = needed.filter(Boolean).length || 1; const total = chars.reduce((a, b) => a + b, 0) || 1;
  let kn = 0, freed = 0;
  for (let i = 0; i < needed.length; i += 1) {
    const k = forced[i] || keep(i);
    if (needed[i] && k) kn += 1;
    if (!k) freed += chars[i]!;
  }
  return { retention: kn / totN, freed: freed / total };
}
function freedAt(p: number[], needed: boolean[], chars: number[], forced: boolean[], floor: number) {
  let best = 0;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const r = realize((i) => p[i]! >= t, needed, chars, forced);
    if (r.retention >= floor && r.freed > best) best = r.freed;
  }
  return Number((100 * best).toFixed(1));
}

function main() {
  const root = join(homedir(), '.codex', 'sessions');
  let files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const f = join(d, e); statSync(f).isDirectory() ? walk(f) : (e.startsWith('rollout-') && e.endsWith('.jsonl') && files.push(f)); } };
  try { walk(root); } catch { console.log('no ~/.codex/sessions on this machine'); return; }
  const t0 = performance.now();
  const rows = files.flatMap((f) => labelSession(f, f.split('/').pop()!.slice(8, 40)));
  const ms = performance.now() - t0;
  if (rows.length === 0) { console.log('no labellable Codex calls'); return; }
  const needed = rows.map((r) => r.needed), chars = rows.map((r) => r.chars);
  const forced = rows.map((r) => MUTATING.has(r.tool) || UNREPEATABLE.has(r.tool));
  const keepResult = rows.map((r) => score(KEEP_RESULT_WEIGHTS, r.feats));
  const pos = needed.filter(Boolean).length;

  console.log(`Codex corpus: ${rows.length} calls, ${files.length} sessions, ${pos} needed (${(100 * pos / rows.length).toFixed(1)}%)`);
  console.log(`parsed+scored in ${ms.toFixed(0)} ms (${(1000 * ms / rows.length).toFixed(1)} us/call)`);
  const byTool = new Map<string, number>(); rows.forEach((r) => byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + 1));
  console.log('tools:', [...byTool].map(([t, n]) => `${t}:${n}`).join(' '));
  if (pos >= 5 && pos < rows.length) {
    const transferAuc = Number(auc(keepResult, needed).toFixed(3));
    const f90 = freedAt(keepResult, needed, chars, forced, 0.9);
    const f85 = freedAt(keepResult, needed, chars, forced, 0.85);
    console.log(`\nSHIPPED weights, no refit, on Codex:`);
    console.log(`  result_needed AUC ${transferAuc.toFixed(3)}  (Claude Code corpus: 0.789 LOSO)`);
    console.log(`  freed@90% retention ${f90}%  freed@85% ${f85}%`);
    console.log(`  (Claude Code shipped decideAll: 20.7% freed @ 85.4% retention)`);
    if (process.argv.includes('--write')) {
      const fixture = {
        calls: rows.length, sessions: files.length, positives: pos,
        neededPct: Number((100 * pos / rows.length).toFixed(1)),
        transferAuc, freed90: f90, freed85: f85,
        tools: Object.fromEntries(byTool),
        note: 'aggregates only, measured on THIS machine\'s ~/.codex; re-run eval/codex-transfer.ts on your own. Small sample: treat as directional.',
      };
      writeFileSync(join(import.meta.dirname, 'fixtures', 'codex-transfer.json'), JSON.stringify(fixture, null, 2) + '\n');
      console.log('\nwrote fixtures/codex-transfer.json');
    }
  } else {
    console.log(`\ntoo few positives (${pos}) to measure transfer — Codex outputs are rarely quoted verbatim downstream.`);
  }
}
main();
