/**
 * Does a cap on kept outputs compose with the ranking, or overlap it?
 *
 * `eval/where-reused.ts` establishes the premise: reuse is spread through an
 * output rather than gathered at its head (median depth 0.46), so a head cap is
 * close to uniform sampling of it — and yet capping every output at 8,000
 * characters frees about a third of the corpus from under 6% of the calls,
 * because the size distribution is that lopsided.
 *
 * The obvious worry is that the two levers are the same lever: the scorer
 * already drops large outputs, so maybe a cap only re-frees what dropping
 * freed. This measures all four corners on one corpus with one metric.
 *
 *   keep everything          the ceiling on what is there to free
 *   ranking only             the shipped policy: drop below the floor
 *   cap only                 no ranking at all, every output capped
 *   ranking then cap         drop below the floor, cap what survives
 *
 * The retention metric is the share of REUSED SHINGLES still present. It is the
 * only measure the two levers can share: dropping loses whole outputs and
 * capping loses the far end of one, and "outputs kept" cannot see the second.
 * A dropped output keeps `truncateHeadChars`, so its head counts here too —
 * the shipped policy is not charged for content it actually preserves.
 *
 * Reads the transcripts on this machine. Aggregates only; writes nothing.
 *
 * Run: bun eval/cap.ts
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_OPTIONS } from '../src/compact.js';
import { noulAnswer } from '../src/request.js';
import { FeatureAsker } from '../src/features.js';
import { MUTATING, buildCallState, callContexts, collectToolCalls, goalFromMessages } from '../src/state.js';
import { questionsFor } from '../src/questions.js';
import { readTranscript } from './transcript.js';

/** `keepResult` above which an output keeps the wide cap; then wide, then tight. */
const GRADED: [number, number, number][] = [
  [0.6, 32_000, 12_000],
  [0.6, 24_000, 8_000],
  [0.8, 48_000, 8_000],
];

const SHINGLE = 8;
const MAX_SHINGLES = 2_000;
const BOILERPLATE_OWNERS = 3;
const MIN_MATCHES = 2;
const PRESERVE_RECENT = 6;
const HEAD = DEFAULT_OPTIONS.truncateHeadChars;
const FLOOR = DEFAULT_OPTIONS.keepThreshold;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (entry.endsWith('.jsonl')) out.push(path);
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

type Call = {
  session: string;
  chars: number;
  /** Offsets of this output's shingles that later text reused. */
  hits: number[];
  keepResult: number;
  mutating: boolean;
};

const asker = new FeatureAsker();
const all: Call[] = [];
let sessions = 0;

for (const path of walk(join(homedir(), '.claude', 'projects'))) {
  let messages;
  try {
    messages = readTranscript(path);
  } catch {
    continue;
  }
  const found = collectToolCalls(messages, PRESERVE_RECENT);
  if (found.length === 0) continue;
  sessions += 1;

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

  // Exactly the state production sends, so the scores are the shipped ones.
  const contexts = callContexts(found, messages.length);
  const goal = goalFromMessages(messages);
  for (const call of found) {
    const context = contexts.get(call.id);
    if (context === undefined) continue;
    const state = buildCallState(call, context, goal, DEFAULT_OPTIONS.maxCallStateTokens);
    const questions = questionsFor(call, DEFAULT_OPTIONS.phrasing);
    const { answers } = await asker.ask(state, questions);
    const hits = hitsOf.get(call.id);
    all.push({
      session: path,
      chars: call.resultChars,
      hits: hits !== undefined && hits.size >= MIN_MATCHES ? [...hits.values()] : [],
      keepResult: noulAnswer(answers, `result_${call.id}`),
      mutating: MUTATING.has(call.tool),
    });
  }
}

const corpus = all.reduce((s, c) => s + c.chars, 0);
const reused = all.reduce((s, c) => s + c.hits.length, 0);

/**
 * Characters surviving one policy, and how many reused shingles survive with
 * them. `drop` applies the floor; `cap` truncates whatever is still there.
 */
type Cap = number | ((call: Call) => number);
const capOf = (cap: Cap, call: Call): number => (typeof cap === 'number' ? cap : cap(call));

/**
 * A cap that varies with how sure the scorer is.
 *
 * The flat cap and the ranking overlap badly in the tail: at 16,000 the corpus
 * frees 29.5% but the number of sessions keeping under half of what was quoted
 * from them goes from 2 to 3. The cap cannot tell a 40,000-character output the
 * scorer was confident about from one it merely did not drop, and the ranking
 * has that information already. This spends the tight cap only on the outputs
 * the scorer was lukewarm about, and leaves the confident ones long.
 *
 * It does not work, and the rows below are why it is not shipped: every grading
 * frees more than the flat 24,000 cap and costs more than the flat 16,000 one,
 * taking the sessions that keep under half of what was quoted from them from 2
 * to 4 or 5. `keepResult` is the probability the output is needed *at all*; it
 * says nothing about where in the output the reuse sits, and among the outputs
 * that survived the floor it has already spent its information.
 */
const graded = (strong: number, wide: number, tight: number): Cap =>
  (call: Call): number => (call.keepResult >= strong ? wide : tight);

function run(drop: boolean, cap: Cap): { kept: number; shingles: number } {
  let kept = 0;
  let shingles = 0;
  for (const call of all) {
    // What the policy leaves of this output, as a prefix length.
    let prefix = call.chars;
    if (drop && !call.mutating && call.keepResult < FLOOR) prefix = Math.min(HEAD, call.chars);
    const limit = capOf(cap, call);
    if (limit > 0) prefix = Math.min(prefix, limit);
    kept += prefix;
    shingles += call.hits.filter((at) => at < prefix).length;
  }
  return { kept, shingles };
}

const show = (name: string, drop: boolean, cap: Cap): void => {
  const { kept, shingles } = run(drop, cap);
  console.log(`${name.padEnd(26)}${(100 * (1 - kept / corpus)).toFixed(1).padStart(8)}%` +
    `${((100 * shingles) / reused).toFixed(1).padStart(14)}%`);
};

console.log(`corpus: ${sessions} sessions, ${all.length} calls, ${corpus.toLocaleString()} characters`);
console.log(`reused shingles to protect: ${reused.toLocaleString()}`);
console.log(`floor ${FLOOR}, dropped outputs keep their first ${HEAD} characters\n`);
console.log(`${'policy'.padEnd(26)}${'freed'.padStart(9)}${'reuse kept'.padStart(14)}`);
console.log('-'.repeat(49));
show('keep everything', false, 0);
show('ranking only (shipped)', true, 0);
for (const cap of [32_000, 24_000, 16_000, 8_000, 4_000]) show(`cap ${cap.toLocaleString()} only`, false, cap);
for (const cap of [32_000, 24_000, 16_000, 8_000, 4_000]) show(`ranking + cap ${cap.toLocaleString()}`, true, cap);
for (const [strong, wide, tight] of GRADED) {
  show(`ranking + graded ${strong}/${(wide / 1000)}k/${tight / 1000}k`, true, graded(strong, wide, tight));
}
console.log('\nfreed = share of all output characters removed.');
console.log('reuse kept = share of shingles later text quoted that are still present.');

/**
 * One session holds a third of these calls, so the aggregate above could be one
 * session's habits wearing a corpus as a disguise. This repeats the comparison
 * inside each session that has something to lose, and reports the spread.
 */
const bySession = new Map<string, Call[]>();
for (const call of all) bySession.set(call.session, [...(bySession.get(call.session) ?? []), call]);
const per = (calls: Call[], drop: boolean, cap: Cap): { freed: number; kept: number } => {
  const total = calls.reduce((s, c) => s + c.chars, 0);
  const reusedHere = calls.reduce((s, c) => s + c.hits.length, 0);
  let keptChars = 0;
  let keptHits = 0;
  for (const call of calls) {
    let prefix = call.chars;
    if (drop && !call.mutating && call.keepResult < FLOOR) prefix = Math.min(HEAD, call.chars);
    const limit = capOf(cap, call);
    if (limit > 0) prefix = Math.min(prefix, limit);
    keptChars += prefix;
    keptHits += call.hits.filter((at) => at < prefix).length;
  }
  return {
    freed: total === 0 ? 0 : 100 * (1 - keptChars / total),
    kept: reusedHere === 0 ? 100 : (100 * keptHits) / reusedHere,
  };
};
// Only sessions with reuse to lose: elsewhere retention is 100% by vacancy.
const scored = [...bySession.values()].filter((c) => c.reduce((s, x) => s + x.hits.length, 0) >= 10);
const quart = (xs: number[], p: number): number =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
console.log(`\nper session, over the ${scored.length} sessions with 10+ reused shingles`);
console.log('ruinous = sessions keeping under half of what was quoted from them');
console.log(`${'policy'.padEnd(26)}${'freed med'.padStart(11)}${'kept med'.padStart(10)}` +
  `${'kept p10'.padStart(9)}${'kept worst'.padStart(11)}${'ruinous'.padStart(9)}`);
console.log('-'.repeat(76));
for (const [name, drop, cap] of [
  ['ranking only (shipped)', true, 0],
  ['cap 8,000 only', false, 8_000],
  ['ranking + cap 8,000', true, 8_000],
  ['cap 16,000 only', false, 16_000],
  ['cap 32,000 only', false, 32_000],
  ['ranking + cap 32,000', true, 32_000],
  ['ranking + cap 24,000', true, 24_000],
  ['ranking + cap 16,000', true, 16_000],
  ...GRADED.map(([strong, wide, tight]) =>
    [`ranking + graded ${strong}/${wide / 1000}k/${tight / 1000}k`, true, graded(strong, wide, tight)] as [string, boolean, Cap]),
] as [string, boolean, Cap][]) {
  const runs = scored.map((c) => per(c, drop, cap));
  const kepts = runs.map((r) => r.kept);
  console.log(`${name.padEnd(26)}${quart(runs.map((r) => r.freed), 0.5).toFixed(1).padStart(10)}%` +
    `${quart(kepts, 0.5).toFixed(1).padStart(9)}%` +
    `${quart(kepts, 0.1).toFixed(1).padStart(9)}%` +
    `${Math.min(...kepts).toFixed(1).padStart(11)}%` +
    `${String(kepts.filter((k) => k < 50).length).padStart(9)}`);
}
