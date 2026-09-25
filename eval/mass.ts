/**
 * Where the characters actually are.
 *
 * Every policy here so far acts on tool *output*: the ranking drops a result,
 * the cap shortens one. The question this asks is whether that is where the
 * mass is. It is not obviously so — a `MultiEdit` input carries both sides of
 * every edit, and a `Write` input carries the whole file.
 *
 * Reads the transcripts on this machine. Aggregates only; writes nothing.
 *
 * Run: bun eval/mass.ts
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readTranscript } from './transcript.js';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    try {
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (entry.endsWith('.jsonl')) out.push(path);
    } catch { /* a session being written can vanish mid-walk */ }
  }
  return out;
}

const paths = walk(join(homedir(), '.claude', 'projects'))
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 24);

type Bucket = { input: number; output: number; calls: number };
const byTool = new Map<string, Bucket>();
let prose = 0;
let sessions = 0;

for (const { path } of paths) {
  const messages = readTranscript(path);
  if (messages.length < 20) continue;
  sessions += 1;
  for (const message of messages) {
    prose += message.text.length;
    const results = new Map((message.toolResults ?? []).map((r) => [r.tool_use_id, r.text.length]));
    for (const tool of message.toolUses) {
      const bucket = byTool.get(tool.tool) ?? { input: 0, output: 0, calls: 0 };
      let input = 0;
      try { input = JSON.stringify(tool.input).length; } catch { input = 20; }
      bucket.input += input;
      bucket.output += (tool.text ?? '').length;
      bucket.calls += 1;
      byTool.set(tool.tool, bucket);
    }
    // Results arrive on the following message, keyed by id; charge them to the
    // tool that produced them by looking the id up in the whole transcript.
    for (const [, length] of results) {
      const bucket = byTool.get('__unpaired') ?? { input: 0, output: 0, calls: 0 };
      bucket.output += length;
      byTool.set('__unpaired', bucket);
    }
  }
  // Second pass: move the unpaired output onto its own tool.
  const owner = new Map<string, string>();
  for (const message of messages) {
    for (const tool of message.toolUses) owner.set(tool.tool_use_id, tool.tool);
  }
  const unpaired = byTool.get('__unpaired');
  if (unpaired) { unpaired.output = 0; }
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      const tool = owner.get(result.tool_use_id) ?? 'unknown';
      const bucket = byTool.get(tool) ?? { input: 0, output: 0, calls: 0 };
      bucket.output += result.text.length;
      byTool.set(tool, bucket);
    }
  }
}
byTool.delete('__unpaired');

const rows = [...byTool.entries()]
  .map(([tool, b]) => ({ tool, ...b, total: b.input + b.output }))
  .sort((a, b) => b.total - a.total);
const total = rows.reduce((sum, row) => sum + row.total, 0) + prose;
const inputTotal = rows.reduce((sum, row) => sum + row.input, 0);
const outputTotal = rows.reduce((sum, row) => sum + row.output, 0);

const pct = (n: number): string => `${((100 * n) / total).toFixed(1)}%`;
console.log(`${sessions} sessions, ${total.toLocaleString()} characters\n`);
console.log(`prose (never touched)      ${pct(prose).padStart(7)}  ${prose.toLocaleString().padStart(12)}`);
console.log(`tool input                 ${pct(inputTotal).padStart(7)}  ${inputTotal.toLocaleString().padStart(12)}`);
console.log(`tool output                ${pct(outputTotal).padStart(7)}  ${outputTotal.toLocaleString().padStart(12)}\n`);

console.log(`${'tool'.padEnd(18)}${'calls'.padStart(7)}${'input'.padStart(13)}${'output'.padStart(13)}${'in/call'.padStart(9)}${'share'.padStart(8)}`);
console.log('-'.repeat(68));
for (const row of rows.slice(0, 14)) {
  console.log(`${row.tool.slice(0, 17).padEnd(18)}${String(row.calls).padStart(7)}` +
    `${row.input.toLocaleString().padStart(13)}${row.output.toLocaleString().padStart(13)}` +
    `${(row.calls ? Math.round(row.input / row.calls) : 0).toLocaleString().padStart(9)}` +
    `${pct(row.total).padStart(8)}`);
}
