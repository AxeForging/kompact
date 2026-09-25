/**
 * When an output is needed, which PART of it is needed?
 *
 * The shipped policy is binary: a call's output is kept whole or dropped to a
 * 300-character head. That is the right shape only if a needed output is needed
 * all over. It is not. On the labelled corpus the median needed output has
 * 4.8% of its shingles reused later, and needed outputs hold a quarter of every
 * character in the corpus — so most of what the policy protects is protected
 * for the sake of a few lines inside it.
 *
 * This asks the question the ranking cannot: given that an output IS reused,
 * where in it does the reuse fall, and what would a head-and-tail budget keep?
 *
 * Method mirrors `eval/extract-labels.ts` exactly — same 8-word shingles, same
 * boilerplate rule, same "only later text can match" ordering — with one
 * addition: each sampled shingle carries its word offset, so a match can be
 * placed inside the output it came from.
 *
 * Reads the transcripts already on this machine. Prints aggregates only: no
 * output text, no paths, nothing written to disk.
 *
 * Run: bun eval/where-reused.ts [--tail 0.25]
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { collectToolCalls } from '../src/state.js';
import { readTranscript } from './transcript.js';

const SHINGLE = 8;
const MAX_SHINGLES = 2_000;
const BOILERPLATE_OWNERS = 3;
const MIN_MATCHES = 2;
const PRESERVE_RECENT = 6;

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? Number(args[at + 1]) : fallback;
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (entry.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

/** Words with their character offsets, so a shingle can be placed in the text. */
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

/** Sampled shingles of an output, each with the character offset it starts at. */
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

type Needed = {
  chars: number;
  /** Character offset of every distinct shingle of this output that was reused. */
  hits: number[];
  tool: string;
};

const projects = join(homedir(), '.claude', 'projects');
const files = walk(projects);
const needed: Needed[] = [];
/** Every call's output size, so a budget can be costed over the whole corpus. */
const sizes: number[] = [];
let calls = 0;
let sessions = 0;
let corpusChars = 0;

for (const path of files) {
  let messages;
  try {
    messages = readTranscript(path);
  } catch {
    continue;
  }
  const found = collectToolCalls(messages, PRESERVE_RECENT);
  if (found.length === 0) continue;
  sessions += 1;
  calls += found.length;

  const byResultIndex = new Map<number, typeof found>();
  for (const call of found) {
    const list = byResultIndex.get(call.resultIndex) ?? [];
    list.push(call);
    byResultIndex.set(call.resultIndex, list);
  }

  const owners = new Map<string, number>();
  const sampledOf = new Map<string, { shingle: string; at: number }[]>();
  for (const call of found) {
    const list = sampledAt(call.resultText);
    sampledOf.set(call.id, list);
    for (const shingle of new Set(list.map((x) => x.shingle))) {
      owners.set(shingle, (owners.get(shingle) ?? 0) + 1);
    }
  }

  // shingle -> (call id -> character offset within that call's output)
  const pending = new Map<string, Map<string, number>>();
  const hitsOf = new Map<string, Map<string, number>>();

  messages.forEach((message, index) => {
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
        for (const [id, at] of holders) {
          const seen = hitsOf.get(id) ?? new Map<string, number>();
          seen.set(shingle, at);
          hitsOf.set(id, seen);
        }
      }
    }
    for (const call of byResultIndex.get(index) ?? []) {
      for (const { shingle, at } of sampledOf.get(call.id) ?? []) {
        if ((owners.get(shingle) ?? 0) > BOILERPLATE_OWNERS) continue;
        const holders = pending.get(shingle) ?? new Map<string, number>();
        if (!holders.has(call.id)) holders.set(call.id, at);
        pending.set(shingle, holders);
      }
    }
  });

  for (const call of found) {
    corpusChars += call.resultChars;
    sizes.push(call.resultChars);
    const hits = hitsOf.get(call.id);
    if (hits === undefined || hits.size < MIN_MATCHES) continue;
    needed.push({ chars: call.resultChars, hits: [...hits.values()], tool: call.tool });
  }
}

const q = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};

console.log(`corpus: ${sessions} sessions, ${calls} calls, ${corpusChars.toLocaleString()} characters`);
console.log(`needed outputs (>= ${MIN_MATCHES} reused shingles): ${needed.length}`);
const neededChars = needed.reduce((s, n) => s + n.chars, 0);
console.log(`they hold ${neededChars.toLocaleString()} characters, ` +
  `${((100 * neededChars) / corpusChars).toFixed(1)}% of the corpus\n`);

// Where, as a fraction of the output, does the reuse fall?
const depths: number[] = [];
for (const n of needed) {
  for (const at of n.hits) depths.push(n.chars > 0 ? at / n.chars : 0);
}
console.log('depth of a reused shingle, as a fraction of its output');
console.log(`  p10 ${q(depths, 0.1).toFixed(3)}  p25 ${q(depths, 0.25).toFixed(3)}  ` +
  `median ${q(depths, 0.5).toFixed(3)}  p75 ${q(depths, 0.75).toFixed(3)}  p90 ${q(depths, 0.9).toFixed(3)}`);
console.log(`  share in the first 10% of the output: ${((100 * depths.filter((d) => d <= 0.1).length) / depths.length).toFixed(1)}%`);
console.log(`  share in the last  10% of the output: ${((100 * depths.filter((d) => d >= 0.9).length) / depths.length).toFixed(1)}%\n`);

/**
 * What a head-and-tail budget keeps.
 *
 * An output longer than `budget` is replaced by its first `head` and last
 * `tail` characters. A reused shingle survives if it starts inside either.
 * Reported as: characters freed across the whole corpus, and the share of
 * needed outputs that keep EVERY shingle that was reused from them — the strict
 * reading, because losing one of two matches may be losing the one that counted.
 */
const tailShares = [0, flag('--tail', 0.25)].filter((v, i, a) => a.indexOf(v) === i);
console.log(`${'budget'.padStart(8)}${'tail'.padStart(7)}${'freed'.padStart(9)}` +
  `${'shingles kept'.padStart(15)}${'outputs intact'.padStart(16)}`);
console.log('-'.repeat(55));
for (const budget of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
  for (const tailShare of tailShares) {
    const tail = Math.round(budget * tailShare);
    const head = budget - tail;
    let freed = 0;
    let kept = 0;
    let all = 0;
    let intact = 0;
    for (const n of needed) {
      if (n.chars <= budget) {
        kept += n.hits.length;
        all += n.hits.length;
        intact += 1;
        continue;
      }
      freed += n.chars - budget;
      const survive = n.hits.filter((at) => at < head || at >= n.chars - tail).length;
      kept += survive;
      all += n.hits.length;
      if (survive === n.hits.length) intact += 1;
    }
    // Everything not needed is the policy's business, not this one's; the freed
    // figure here is only what truncating the KEPT outputs would add.
    console.log(`${budget.toLocaleString().padStart(8)}${(100 * tailShare).toFixed(0).padStart(6)}%` +
      `${((100 * freed) / corpusChars).toFixed(1).padStart(8)}%` +
      `${((100 * kept) / all).toFixed(1).padStart(14)}%` +
      `${((100 * intact) / needed.length).toFixed(1).padStart(15)}%`);
  }
}
console.log('\nfreed = share of ALL corpus characters this would remove from outputs the');
console.log('policy currently keeps whole. It adds to what dropping already frees.');

/**
 * The same cap applied to every output, needed or not.
 *
 * The table above only costs the needed ones, because those are what a cap can
 * damage. This is what it would actually free: the policy keeps roughly 78% of
 * characters today, and a cap takes its share out of all of them at once,
 * whatever the ranking decided.
 */
console.log(`\n${'cap'.padStart(8)}${'over cap'.padStart(10)}${'corpus freed'.padStart(14)}` +
  `${'shingles kept'.padStart(15)}`);
console.log('-'.repeat(47));
for (const budget of [2_000, 4_000, 8_000, 16_000, 32_000]) {
  const over = sizes.filter((n) => n > budget).length;
  const freed = sizes.reduce((s, n) => s + Math.max(0, n - budget), 0);
  let kept = 0;
  let all = 0;
  for (const n of needed) {
    all += n.hits.length;
    kept += n.chars <= budget ? n.hits.length : n.hits.filter((at) => at < budget).length;
  }
  console.log(`${budget.toLocaleString().padStart(8)}${String(over).padStart(10)}` +
    `${((100 * freed) / corpusChars).toFixed(1).padStart(13)}%` +
    `${((100 * kept) / all).toFixed(1).padStart(14)}%`);
}
console.log('\nover cap = calls longer than it, of ' + calls);
