/**
 * The half of the transcript no policy has ever touched.
 *
 * Every lever here acts on tool *output*: the ranking drops a result, the cap
 * shortens one, and a mutating call keeps its input whatever it scores.
 * `eval/mass.ts` says that is 47.1% of the characters. The other 42.7% is tool
 * *input* — a `Write` carries the whole file it wrote, a `SubagentHandback`
 * carries a whole report, a `Bash` carries a heredoc — and nothing shortens any
 * of it.
 *
 * The question is what capping an input would cost, measured the same way the
 * output cap is: the share of 8-word shingles that LATER text quotes which are
 * still present afterwards. Later text means later message prose and later tool
 * inputs, which is where a quoted `old_string` shows up.
 *
 * Reads the transcripts on this machine. Aggregates only; writes nothing.
 *
 * Run: bun eval/inputs.ts
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MUTATING } from '../src/state.js';
import { readTranscript } from './transcript.js';

const SHINGLE = 8;
const MAX_SHINGLES = 2_000;
const BOILERPLATE_OWNERS = 3;

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

function wordsAt(text: string): { word: string; at: number }[] {
  const out: { word: string; at: number }[] = [];
  const re = /[a-z0-9_./-]+/g;
  const lower = text.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) out.push({ word: m[0], at: m.index });
  return out;
}

function allShingles(text: string): Set<string> {
  const w = wordsAt(text);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i += 1) {
    out.add(w.slice(i, i + SHINGLE).map((x) => x.word).join(' '));
  }
  return out;
}

function sampledAt(text: string): { shingle: string; at: number }[] {
  const w = wordsAt(text);
  const total = Math.max(0, w.length - SHINGLE + 1);
  if (total === 0) return [];
  const stride = Math.max(1, Math.ceil(total / MAX_SHINGLES));
  const out: { shingle: string; at: number }[] = [];
  for (let i = 0; i < total; i += stride) {
    out.push({ shingle: w.slice(i, i + SHINGLE).map((x) => x.word).join(' '), at: w[i]!.at });
  }
  return out;
}

type Use = { tool: string; chars: number; hits: number[]; mutating: boolean };

const all: Use[] = [];
let sessions = 0;

for (const path of walk(join(homedir(), '.claude', 'projects'))) {
  let messages;
  try {
    messages = readTranscript(path);
  } catch {
    continue;
  }
  if (messages.length < 20) continue;
  sessions += 1;

  // Every tool input in this session, with where its shingles sit inside it.
  type Entry = { id: string; tool: string; text: string; index: number };
  const entries: Entry[] = [];
  messages.forEach((message, index) => {
    for (const tool of message.toolUses) {
      let text = '';
      try { text = JSON.stringify(tool.input); } catch { text = ''; }
      if (text.length > 0) entries.push({ id: tool.tool_use_id, tool: tool.tool, text, index });
    }
  });
  if (entries.length === 0) continue;

  const owners = new Map<string, number>();
  const sampledOf = new Map<string, { shingle: string; at: number }[]>();
  for (const entry of entries) {
    const list = sampledAt(entry.text);
    sampledOf.set(entry.id, list);
    for (const shingle of new Set(list.map((x) => x.shingle))) {
      owners.set(shingle, (owners.get(shingle) ?? 0) + 1);
    }
  }

  const byIndex = new Map<number, Entry[]>();
  for (const entry of entries) byIndex.set(entry.index, [...(byIndex.get(entry.index) ?? []), entry]);

  const pending = new Map<string, Map<string, number>>();
  const hitsOf = new Map<string, Map<string, number>>();
  messages.forEach((message, index) => {
    // What this message says, which may quote an input that came before it.
    const haystack = [
      message.text,
      ...message.toolUses.map((tool) => {
        try { return JSON.stringify(tool.input); } catch { return ''; }
      }),
    ].join('\n');
    if (haystack.trim() !== '') {
      for (const shingle of allShingles(haystack)) {
        const holders = pending.get(shingle);
        if (holders === undefined) continue;
        for (const [id, at] of holders) {
          const seen = hitsOf.get(id) ?? new Map<string, number>();
          seen.set(shingle, at);
          hitsOf.set(id, seen);
        }
      }
    }
    // Only after: an input cannot be quoted by the message it arrives in.
    for (const entry of byIndex.get(index) ?? []) {
      for (const { shingle, at } of sampledOf.get(entry.id) ?? []) {
        if ((owners.get(shingle) ?? 0) > BOILERPLATE_OWNERS) continue;
        const holders = pending.get(shingle) ?? new Map<string, number>();
        if (!holders.has(entry.id)) holders.set(entry.id, at);
        pending.set(shingle, holders);
      }
    }
  });

  for (const entry of entries) {
    all.push({
      tool: entry.tool,
      chars: entry.text.length,
      hits: [...(hitsOf.get(entry.id)?.values() ?? [])],
      mutating: MUTATING.has(entry.tool),
    });
  }
}

const corpus = all.reduce((sum, use) => sum + use.chars, 0);
const reused = all.reduce((sum, use) => sum + use.hits.length, 0);

console.log(`${sessions} sessions, ${all.length.toLocaleString()} tool inputs, ` +
  `${corpus.toLocaleString()} characters`);
console.log(`reused shingles to protect: ${reused.toLocaleString()}\n`);

const run = (cap: number, tools?: (use: Use) => boolean): { freed: number; kept: number } => {
  let keptChars = 0;
  let keptHits = 0;
  for (const use of all) {
    const applies = tools ? tools(use) : true;
    const prefix = applies && cap > 0 ? Math.min(use.chars, cap) : use.chars;
    keptChars += prefix;
    keptHits += use.hits.filter((at) => at < prefix).length;
  }
  return {
    freed: 100 * (1 - keptChars / corpus),
    kept: reused === 0 ? 100 : (100 * keptHits) / reused,
  };
};

const show = (name: string, cap: number, tools?: (use: Use) => boolean): void => {
  const { freed, kept } = run(cap, tools);
  console.log(`${name.padEnd(34)}${freed.toFixed(1).padStart(8)}%${kept.toFixed(1).padStart(14)}%`);
};

console.log(`${'policy'.padEnd(34)}${'freed'.padStart(9)}${'reuse kept'.padStart(15)}`);
console.log('-'.repeat(58));
for (const cap of [16_000, 8_000, 4_000, 2_000, 1_000]) {
  show(`cap every input at ${cap.toLocaleString()}`, cap);
}
console.log();
// The mutating guard exists for the INPUT, so a cap on it is the risky one and
// is measured on its own rather than folded into an average.
for (const cap of [8_000, 4_000, 2_000]) {
  show(`cap non-mutating inputs at ${cap.toLocaleString()}`, cap, (use) => !use.mutating);
}
console.log();
for (const cap of [8_000, 4_000, 2_000]) {
  show(`cap mutating inputs at ${cap.toLocaleString()}`, cap, (use) => use.mutating);
}

/**
 * The same sweep priced against the whole transcript rather than against tool
 * input alone, because "4.4% of the inputs" is not a number anyone can compare
 * with "20.7% of the corpus" from the output cap.
 */
const INPUT_SHARE = 0.427;
console.log('\nthe same rows, as a share of the whole transcript:');
console.log(`${'policy'.padEnd(34)}${'freed'.padStart(9)}${'reuse kept'.padStart(15)}`);
console.log('-'.repeat(58));
for (const cap of [32_000, 16_000, 12_000, 8_000, 6_000]) {
  const { freed, kept } = run(cap);
  console.log(`${`cap every input at ${cap.toLocaleString()}`.padEnd(34)}` +
    `${(freed * INPUT_SHARE).toFixed(1).padStart(8)}%${kept.toFixed(1).padStart(14)}%`);
}

/**
 * How far into an input the reuse sits.
 *
 * A head cap is only cheap where the reuse is near the front. For tool OUTPUT
 * `eval/where-reused.ts` found median depth 0.46 — the reason a head cap there
 * costs what it does. A Bash input is a different shape: a short command and
 * then, sometimes, a long heredoc.
 */
console.log('\nhow deep into an input the reuse falls:');
console.log(`${'tool'.padEnd(20)}${'reuses'.padStart(9)}${'median depth'.padStart(14)}${'in first 10%'.padStart(14)}`);
console.log('-'.repeat(57));
const depths = new Map<string, number[]>();
for (const use of all) {
  if (use.chars === 0) continue;
  for (const at of use.hits) {
    depths.set(use.tool, [...(depths.get(use.tool) ?? []), at / use.chars]);
  }
}
for (const [tool, list] of [...depths.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
  const sorted = [...list].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const early = list.filter((d) => d < 0.1).length;
  console.log(`${tool.slice(0, 19).padEnd(20)}${String(list.length).padStart(9)}` +
    `${median.toFixed(3).padStart(14)}${`${((100 * early) / list.length).toFixed(1)}%`.padStart(14)}`);
}

console.log('\nwhere the reuse is, by tool:');
console.log(`${'tool'.padEnd(20)}${'inputs'.padStart(8)}${'chars'.padStart(12)}${'reused'.padStart(9)}${'per input'.padStart(11)}`);
console.log('-'.repeat(60));
const byTool = new Map<string, { n: number; chars: number; hits: number }>();
for (const use of all) {
  const row = byTool.get(use.tool) ?? { n: 0, chars: 0, hits: 0 };
  row.n += 1; row.chars += use.chars; row.hits += use.hits.length;
  byTool.set(use.tool, row);
}
for (const [tool, row] of [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 10)) {
  console.log(`${tool.slice(0, 19).padEnd(20)}${String(row.n).padStart(8)}` +
    `${row.chars.toLocaleString().padStart(12)}${String(row.hits).padStart(9)}` +
    `${(row.hits / row.n).toFixed(2).padStart(11)}`);
}
