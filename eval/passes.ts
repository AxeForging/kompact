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

import { TRUNCATION_MARK, compact, messageChars, tokensIn } from '../src/compact.js';
import { FeatureAsker } from '../src/features.js';
import { collectToolCalls } from '../src/state.js';
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

/**
 * What one message costs the window.
 *
 * The same model the shipped rule uses — characters over `CHARS_PER_TOKEN` —
 * rather than `estimateTokens` per message, so this eval measures the thing the
 * hook will actually do. Counting properly here and approximating there would
 * make every pass count in this table slightly optimistic about the real bar.
 */
const messageTokens = (message: Message): number => tokensIn(messageChars(message));

const tokensOf = (messages: readonly Message[]): number =>
  messages.reduce((sum, message) => sum + messageTokens(message), 0);

/**
 * How much of what survives is a receipt rather than a result.
 *
 * The one quality signal a repeated loop has that a single compaction does not.
 * Stubs accumulate monotonically — `decideAll` refuses to drop the call of a
 * result that already carries the mark, and `minYieldChars` refuses to
 * re-truncate one — so after several passes the surviving prose can end up
 * referring to outputs that are now notes saying the output was removed. This
 * counts them; nothing acts on the number yet, which is why it is printed
 * rather than turned into a default.
 */
function stubShare(messages: readonly Message[]): number {
  let results = 0;
  let stubs = 0;
  for (const message of messages) {
    for (const tool of message.toolUses) {
      if (tool.text === undefined) continue;
      results += 1;
      if (tool.text.includes(TRUNCATION_MARK)) stubs += 1;
    }
    for (const result of message.toolResults ?? []) {
      results += 1;
      if (result.text.includes(TRUNCATION_MARK)) stubs += 1;
    }
  }
  return results === 0 ? 0 : stubs / results;
}

const asker = FeatureAsker.fromWeights();
const trigger = Math.round((WINDOW * AT) / 100);
const floorTokens = Math.round((WINDOW * FLOOR) / 100);

type Pass = {
  pp: number; ms: number; tokensBefore: number; tokensAfter: number; taken: boolean;
  /** Why a refused pass was refused. The two are different findings. */
  why: 'taken' | 'floor' | 'ceiling';
  /** Share of surviving tool results that are now a truncation stub. */
  stubs: number;
};

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
    const why = freed < floorTokens ? 'floor' : passes.length >= MAX_PASSES ? 'ceiling' : 'taken';
    const taken = why === 'taken';
    passes.push({
      pp: (100 * freed) / WINDOW, ms, tokensBefore: tokens, tokensAfter: after, taken, why,
      stubs: stubShare(result.messages),
    });
    if (!taken) return passes;
    live = result.messages;
    tokens = after;
  }
  return passes;
}

const PUBLISH = args.includes('--publish');
type Row = { name: string; messages: number; passes: Pass[] };
const rows: Row[] = [];

const paths = walk(join(homedir(), '.claude', 'projects'))
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, SESSIONS);

console.log(`\nwindow ${WINDOW.toLocaleString()} tokens, compacting at ${AT}%, ` +
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
  rows.push({ name, messages: messages.length, passes });
  console.log(
    `${name.padEnd(18)}${String(messages.length).padStart(7)}${String(taken.length).padStart(8)}` +
    `${passes.map((p) => `${p.pp.toFixed(1)}${p.why === 'taken' ? '' : p.why === 'floor' ? '*' : '\u2020'}`).join(' ').padStart(30)}` +
    `${passes.map((p) => Math.round(p.ms)).join(' ').padStart(22)}`,
  );
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

console.log(`\n* = refused by the floor, \u2020 = refused by the ceiling. Neither is taken, but only`);
console.log(`the first says the loop had run out of things worth freeing.`);
console.log(`\n${takenTotal} engine summaries avoided across ${sessionsWithLoop} sessions ` +
  `(${(takenTotal / Math.max(1, sessionsWithLoop)).toFixed(1)} per session that loops at all).`);
console.log(`slowest single pass ${Math.round(slowest)} ms.`);
ppByPass.forEach((values, index) => {
  console.log(`  pass ${index + 1}: median ${median(values).toFixed(1)} pp over ${values.length} sessions`);
});

/**
 * What the loop does to the record, which the pp column cannot show.
 *
 * Every dropped result leaves a note saying it was dropped, and those notes are
 * never removed. Watching the share climb is the only way to see the cost of a
 * repeated loop in the transcript itself.
 */
{
  const byPass: number[][] = [];
  for (const row of rows) {
    row.passes.forEach((pass, index) => { (byPass[index] ??= []).push(pass.stubs); });
  }
  console.log('\nof the tool results that survive, how many are now a truncation note:');
  byPass.forEach((values, index) => {
    console.log(`  after pass ${index + 1}: ${(100 * median(values)).toFixed(1)}% ` +
      `(worst ${(100 * Math.max(...values)).toFixed(1)}%)`);
  });
  console.log('  Nothing acts on this yet. It is the quality signal a single');
  console.log('  compaction does not have, and it is here to be watched.');
}

/**
 * What the shipped default would have done with the same passes.
 *
 * `minReductionRatio: 0.25` asks whether a pass was a large *fraction* of the
 * live context. Every pass above is measured against the window instead, so the
 * two can be compared directly on the same runs: this counts how many of them
 * each bar would take.
 */
if (args.includes('--sweep')) {
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
} else {
  console.log(`\n\`npm run eval:passes\` adds the sweep that set the defaults.`);
}


/**
 * The figure on the landing page.
 *
 * Same contract as `eval/demo.ts` and `eval/signals-page.ts`: the numbers are
 * written into the markup by the script that measured them, so the settled
 * figure is there with scripting off and no number on the page was typed by
 * hand. The animation replays what is already rendered.
 */
if (PUBLISH) {
  /**
   * Writes the measurement, not the markup.
   *
   * `--publish` used to splice `docs/index.html` straight from this machine's
   * transcripts, which meant the newest headline figure on the page could not
   * be regenerated anywhere else — so `npm run docs` left it alone and CI's
   * `git diff --exit-code -- docs/` never saw it. The fixture is committed and
   * `eval/passes-page.ts` renders from it, the same two-step contract the
   * signals figure already uses.
   *
   * Only numbers travel: pass sizes, milliseconds, counts. No transcript
   * content and no session identifiers.
   */
  const { writeFileSync, mkdirSync } = await import('node:fs');
  // The longest loop, which is the one the claim is about. A session that takes
  // one pass is not a ladder and would make the figure say less than the table.
  const best = [...rows].sort(
    (a, b) => b.passes.filter((p) => p.taken).length - a.passes.filter((p) => p.taken).length,
  )[0];
  if (!best) throw new Error('no session looped; nothing to publish');
  const taken = best.passes.filter((pass) => pass.taken);
  const mid = <T>(values: T[]): T | undefined => values[Math.floor(values.length / 2)];
  const stubs: number[] = [];
  best.passes.forEach((pass, index) => { stubs[index] = pass.stubs; });

  const fixture = {
    window: WINDOW,
    at: AT,
    floor: FLOOR,
    maxPasses: MAX_PASSES,
    messages: best.messages,
    sessions: rows.length,
    looped: rows.filter((row) => row.passes.some((pass) => pass.taken)).length,
    avoided: rows.reduce((n, r) => n + r.passes.filter((p) => p.taken).length, 0),
    passesMeasured: everyPass.length,
    oldBarTakes: everyPass.filter((pass) => ratioOf(pass) >= 0.25).length,
    medianMs: Math.round(mid([...taken.map((pass) => pass.ms)].sort((a, b) => a - b)) ?? 0),
    medianPp: Number((mid([...taken.map((pass) => pass.pp)].sort((a, b) => a - b)) ?? 0).toFixed(1)),
    slowestMs: Math.round(Math.max(...best.passes.map((pass) => pass.ms))),
    stubShare: stubs.map((share) => Number((100 * share).toFixed(1))),
    rows: best.passes.map((pass) => ({
      from: Number(((100 * pass.tokensBefore) / WINDOW).toFixed(1)),
      to: Number(((100 * pass.tokensAfter) / WINDOW).toFixed(1)),
      ms: Math.round(pass.ms),
      taken: pass.taken,
      why: pass.why,
    })),
  };
  const dir = join(import.meta.dirname, 'fixtures');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'passes.json');
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`\nwrote ${out}: ${fixture.rows.length} rows, ${taken.length} taken`);
  console.log('`npm run docs` renders it into the page via eval/passes-page.ts.');
}
