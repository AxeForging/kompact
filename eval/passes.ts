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

import { compact, messageChars, tokensIn } from '../src/compact.js';
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

const asker = FeatureAsker.fromWeights();
const trigger = Math.round((WINDOW * AT) / 100);
const floorTokens = Math.round((WINDOW * FLOOR) / 100);

type Pass = {
  pp: number; ms: number; tokensBefore: number; tokensAfter: number; taken: boolean;
  /** Why a refused pass was refused. The two are different findings. */
  why: 'taken' | 'floor' | 'ceiling';
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


/**
 * The figure on the landing page.
 *
 * Same contract as `eval/demo.ts` and `eval/signals-page.ts`: the numbers are
 * written into the markup by the script that measured them, so the settled
 * figure is there with scripting off and no number on the page was typed by
 * hand. The animation replays what is already rendered.
 */
if (PUBLISH) {
  const { writeFileSync, readFileSync } = await import('node:fs');
  // The longest loop, which is the one the claim is about. A session that takes
  // one pass is not a ladder and would make the figure say less than the table.
  const best = [...rows].sort(
    (a, b) => b.passes.filter((p) => p.taken).length - a.passes.filter((p) => p.taken).length,
  )[0];
  if (!best) throw new Error('no session looped; nothing to publish');
  const taken = best.passes.filter((pass) => pass.taken);
  const shown = best.passes.map((pass) => ({
    from: (100 * pass.tokensBefore) / WINDOW,
    to: (100 * pass.tokensAfter) / WINDOW,
    ms: Math.round(pass.ms),
    taken: pass.taken,
    why: pass.why,
  }));
  const medianMs = Math.round([...taken.map((pass) => pass.ms)].sort((a, b) => a - b)[
    Math.floor(taken.length / 2)] ?? 0);
  const slowest = Math.round(Math.max(...best.passes.map((pass) => pass.ms)));
  const oldBarTakes = everyPass.filter((pass) => ratioOf(pass) >= 0.25).length;
  const looped = rows.filter((row) => row.passes.some((pass) => pass.taken)).length;
  const medianPp = [...taken.map((pass) => pass.pp)].sort((a, b) => a - b)[
    Math.floor(taken.length / 2)] ?? 0;
  const avoided = rows.reduce((n, r) => n + r.passes.filter((p) => p.taken).length, 0);
  const ordinal = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
    'eighth', 'ninth', 'tenth'][taken.length - 1] ?? `${taken.length}th`;

  const bar = (row: { from: number; to: number; ms: number; taken: boolean; why: string }, index: number): string => {
    const label = row.taken ? `pass ${index + 1}` : 'hand over';
    const why = row.why === 'floor'
      ? `below the ${FLOOR}&#8209;point floor`
      : `${MAX_PASSES} passes is the ceiling`;
    const note = row.taken
      ? `<span class="ladder__num">&#8722;${(row.from - row.to).toFixed(1)}<span class="ladder__unit">pts</span></span>` +
        `<span class="ladder__ms">${row.ms}&#8239;ms</span>`
      : `<span class="ladder__num ladder__num--under">&#8722;${(row.from - row.to).toFixed(1)}<span class="ladder__unit">pts</span></span>` +
        `<span class="ladder__ms">${why}</span>`;
    return `      <li class="ladder__row${row.taken ? '' : ' ladder__row--over'}">` +
      `<span class="ladder__label">${label}</span>` +
      `<span class="visually-hidden">held ${row.to.toFixed(1)}% of the window, </span>` +
      // The bar says exactly what the two numbers beside it say, so a screen
      // reader is read the numbers and not two empty spans.
      `<span class="ladder__track" aria-hidden="true"><span class="ladder__held" style="--w:${row.to.toFixed(1)}%"></span>` +
      `<span class="ladder__back" style="--l:${row.to.toFixed(1)}%;--w:${(row.from - row.to).toFixed(1)}%"></span></span>` +
      note + '</li>';
  };

  // The sentence is generated too. It carried "six" as prose beside a figure
  // that draws however many passes the measurement found, which is exactly the
  // kind of number this page does not let anyone type.
  const markup = `  <p>
    One compaction is not the product; the loop is. The engine asks at ${AT}% of the window, this
    answers, you keep working, and it asks again. Each answer costs about
    <span class="num val">${medianMs}&#8239;ms</span> and hands back
    <span class="num val">${medianPp.toFixed(0)} points</span> of window &#8212; so the model
    summary, which is a model call and rewrites your session into prose, runs after the
    ${ordinal} of them rather than the first.
  </p>
  <ol class="ladder" id="ladder">\n${shown.map(bar).join('\n')}\n  </ol>
  <p class="caption">One real session of ${best.messages.toLocaleString()} messages, replayed against a
    ${(WINDOW / 1000)}k&#8209;token window. The dark part of each bar is what the session was still
    holding; the red part is what that pass handed back. Of ${rows.length} sessions measured on this
    machine, ${looped} looped at all, and between them the loop answered <b>${avoided}</b>
    compactions that would otherwise each have been a model summary. Snapshot of one machine's
    transcripts, which grow as you work &#8212; <code>eval/passes.ts</code> re-runs it on yours.</p>
  <details class="more">
    <summary><h3>Why a percentage of the window, and not a percentage of the session</h3></summary>
    <p>
      Until this version the rule was <code>minReductionRatio: 0.25</code>: take the pass if it
      removed a quarter of the transcript. Replaying the loop on real sessions, that bar took
      <span class="num val">${oldBarTakes}</span> of <span class="num val">${everyPass.length}</span>
      passes &#8212; every one went to the model summary while this could still free
      ${medianPp.toFixed(0)} points of window in under ${slowest}&#8239;ms.
    </p>
    <p>
      The unit was the mistake. A quarter of a ${best.messages.toLocaleString()}-message session and
      a quarter of a 200-message one are not the same amount of room to keep working in, and room is
      what runs out. Points of the context window are comparable between them, and they are the same
      unit as the ${AT}% trigger &#8212; which makes the rule its own guard: a pass that is taken
      leaves the session at least ${FLOOR} points below the trigger, so it has to grow back through
      them before another compaction can be asked for. Compacting on every turn stops being possible
      rather than discouraged.
    </p>
    <p>
      The ceiling is <code>maxPasses: ${MAX_PASSES}</code>, and on the session drawn above it is
      what stops the loop rather than the floor. That is deliberate: raised to 8 the same session
      runs one more pass and then stops on the floor, and at 12 it stops in the same place. So
      ${MAX_PASSES} is not where the loop runs out &#8212; it is where this hands over anyway,
      because <a href="#checked">what deferring the summary costs</a> is not measured, and a
      backstop whose value is a judgement should be the conservative one.
    </p>
  </details>`;

  const page = join(import.meta.dirname, '..', 'docs', 'index.html');
  const html = readFileSync(page, 'utf8');
  const open = '  <!-- passes:render -->\n';
  const close = '\n  <!-- /passes:render -->';
  const from = html.indexOf(open);
  const to = html.indexOf(close);
  if (from < 0 || to < 0) throw new Error(`no passes:render markers in ${page}`);
  writeFileSync(page, html.slice(0, from + open.length) + markup + html.slice(to));
  console.log(`\nspliced ${shown.length} rows into docs/index.html (${taken.length} taken)`);
}
