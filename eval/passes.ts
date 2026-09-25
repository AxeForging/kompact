/**
 * How many times kompact can answer a compaction before it stops earning it.
 *
 * Every other script here measures one compaction. The product question is a
 * loop: the engine asks at `compactAtPercent`, kompact answers, the session
 * keeps growing, and the engine asks again. What decides whether that loop is
 * worth having is not how much the first pass frees — that is `sessions.ts` —
 * but how many passes happen before one of them stops buying enough room to be
 * worth taking instead of the model summary.
 *
 * Two things make this different from feeding a pass its own output:
 *
 *   1. **Fresh material arrives between passes.** Compacting the same transcript
 *      six times measures exhaustion and reports a decay that production never
 *      sees. Here each pass gets the compacted prefix *plus the real
 *      continuation*, which is what the session actually looks like when the
 *      bar next fills.
 *   2. **The unit is percentage points of the context window**, not a ratio of
 *      the transcript. 10% of a large session and 10% of a small one are not
 *      the same amount of room to keep working in, and the window is what runs
 *      out.
 *
 * Run: bun eval/passes.ts [--window 200000] [--at 60] [--floor 5] [--max 4]
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compact } from '../src/compact.js';
import { FeatureAsker } from '../src/features.js';
import { collectToolCalls, estimateTokens } from '../src/state.js';
import { readTranscript } from './transcript.js';
import type { Message } from '../src/index.js';

const args = process.argv.slice(2);
const num = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};

const WINDOW = num('--window', 200_000);
const AT = num('--at', 60);
/** Percentage points of the window a pass must reclaim to be worth taking. */
const FLOOR = num('--floor', 5);
const MAX_PASSES = num('--max', 6);
const SESSIONS = num('--sessions', 24);
/** `maxKeptChars`; -1 leaves the shipped default alone. */
const CAP = num('--cap', -1);

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

/** What one message costs the window, the way `src/state.ts` counts it. */
function messageTokens(message: Message): number {
  let total = estimateTokens(message.text);
  for (const tool of message.toolUses) {
    total += estimateTokens(JSON.stringify(tool.input)) + estimateTokens(tool.text ?? '');
  }
  for (const result of message.toolResults ?? []) total += estimateTokens(result.text);
  return total;
}

const tokensOf = (messages: readonly Message[]): number =>
  messages.reduce((sum, message) => sum + messageTokens(message), 0);

const asker = FeatureAsker.fromWeights();
const trigger = Math.round((WINDOW * AT) / 100);
const floorTokens = Math.round((WINDOW * FLOOR) / 100);

type Pass = { pp: number; ms: number; tokensBefore: number; tokensAfter: number; taken: boolean };

/** What `minReductionRatio` sees: freed as a share of the live context. */
const ratioOf = (pass: Pass): number => pass.pp * WINDOW / 100 / pass.tokensBefore;

/**
 * One session's loop.
 *
 * `live` is what the engine would be holding. Messages are appended from the
 * real transcript until the window crosses the trigger; that is a compaction
 * the engine would ask for, and kompact answers it. The pass is *taken* if it
 * reclaimed at least the floor; otherwise the loop stops there, which is the
 * hand-over.
 */
async function runSession(all: readonly Message[]): Promise<Pass[]> {
  const passes: Pass[] = [];
  let live: Message[] = [];
  let tokens = 0;
  let next = 0;
  while (next < all.length) {
    const message = all[next] as Message;
    live.push(message);
    tokens += messageTokens(message);
    next += 1;
    if (tokens < trigger) continue;
    const started = performance.now();
    const result = await compact(live, asker, CAP >= 0 ? { maxKeptChars: CAP } : {});
    const ms = performance.now() - started;
    const after = tokensOf(result.messages);
    const freed = tokens - after;
    const taken = freed >= floorTokens && passes.length < MAX_PASSES;
    passes.push({
      pp: (100 * freed) / WINDOW, ms, tokensBefore: tokens, tokensAfter: after, taken,
    });
    if (!taken) return passes;
    live = result.messages;
    tokens = after;
  }
  return passes;
}

const paths = walk(join(homedir(), '.claude', 'projects'))
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, SESSIONS);

console.log(`window ${WINDOW.toLocaleString()} tokens, compacting at ${AT}%, ` +
  `floor ${FLOOR} pp (${floorTokens.toLocaleString()} tokens), ceiling ${MAX_PASSES} passes\n`);
console.log(`${'session'.padEnd(18)}${'msgs'.padStart(7)}${'passes'.padStart(8)}` +
  `${'pp reclaimed per pass'.padStart(30)}${'ms per pass'.padStart(22)}`);
console.log('-'.repeat(85));

const everyPass: Pass[] = [];
let takenTotal = 0;
let sessionsWithLoop = 0;
let slowest = 0;
const ppByPass: number[][] = [];
for (const { path } of paths) {
  const messages = readTranscript(path);
  if (collectToolCalls(messages, 6).length < 5) continue;
  const passes = await runSession(messages);
  if (passes.length === 0) continue;
  const taken = passes.filter((pass) => pass.taken);
  takenTotal += taken.length;
  if (taken.length > 0) sessionsWithLoop += 1;
  slowest = Math.max(slowest, ...passes.map((pass) => pass.ms));
  everyPass.push(...passes);
  passes.forEach((pass, index) => {
    (ppByPass[index] ??= []).push(pass.pp);
  });
  const name = path.split('/').pop()?.slice(0, 8) ?? '?';
  console.log(
    `${name.padEnd(18)}${String(messages.length).padStart(7)}${String(taken.length).padStart(8)}` +
    `${passes.map((p) => `${p.pp.toFixed(1)}${p.taken ? '' : '*'}`).join(' ').padStart(30)}` +
    `${passes.map((p) => Math.round(p.ms)).join(' ').padStart(22)}`,
  );
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

console.log(`\n* = the pass that fell below the floor; that is the hand-over, and it is not taken.`);
console.log(`\n${takenTotal} engine summaries avoided across ${sessionsWithLoop} sessions ` +
  `(${(takenTotal / Math.max(1, sessionsWithLoop)).toFixed(1)} per session that loops at all).`);
console.log(`slowest single pass ${Math.round(slowest)} ms.`);
ppByPass.forEach((values, index) => {
  console.log(`  pass ${index + 1}: median ${median(values).toFixed(1)} pp over ${values.length} sessions`);
});

/**
 * What the shipped default would have done with the same passes.
 *
 * `minReductionRatio: 0.25` asks whether a pass was a large *fraction* of the
 * live context. Every pass above is measured against the window instead, so the
 * two can be compared directly on the same runs: this counts how many of them
 * each bar would take.
 */
console.log(`\nwhat each bar takes, over the ${everyPass.length} passes measured:`);
for (const ratio of [0.25, 0.15, 0.10, 0.08, 0.05]) {
  const taken = everyPass.filter((pass) => ratioOf(pass) >= ratio).length;
  console.log(`  minReductionRatio ${ratio.toFixed(2).padStart(5)}  takes ${String(taken).padStart(3)} of ${everyPass.length}`);
}
for (const pp of [3, 4, 5, 7, 10]) {
  const taken = everyPass.filter((pass) => pass.pp >= pp).length;
  console.log(`  minFreedPercent  ${String(pp).padStart(5)}  takes ${String(taken).padStart(3)} of ${everyPass.length}`);
}
console.log(`\nratio seen per pass: ${everyPass.map((p) => ratioOf(p).toFixed(2)).join(' ')}`);
