/**
 * What repetition actually costs, in tokens and in seconds.
 *
 * The skill proposer ranks what you repeat by `estimateSaved`, which is
 * `occurrences * (calls + chars/1000)` — a unitless model of effort that the
 * report is careful to label as such. It is honest and it is also unreadable:
 * a row saying `677.4` tells a reader nothing they can feel, and the rows it
 * puts on top are generic shell verbs that no skill improves.
 *
 * Two units a reader can feel are available and were never collected:
 *
 *   1. **Tokens.** The output a repeated shape has poured into context across
 *      your sessions, through the same `tokensIn` the product uses.
 *   2. **Seconds.** Claude Code transcripts carry an ISO timestamp on every
 *      message, so the gap between a `tool_use` and its `tool_result` is the
 *      wall-clock that call actually took. Nothing in this repository had ever
 *      read it.
 *
 * What this is NOT: a promise of savings. It measures what a shape has cost,
 * not what encoding it as a skill would recover — nothing here has measured
 * whether a drafted skill helps at all, and that stays on the ledger. The
 * difference matters: "this shape cost you 41 minutes" is measured, and "a
 * skill would save you 41 minutes" is not, because a skill does not stop you
 * needing to read files.
 *
 * The tail is reported separately for the same reason. A `tool_result` that
 * arrives 52 minutes after its call is usually a background job or a session
 * left open, not a tool that ran for 52 minutes, so a trimmed total is printed
 * beside the raw one rather than quietly replacing it.
 *
 * `--publish` writes `eval/fixtures/repetition.json` for the page to draw. Like
 * every other machine-local measurement here, the numbers come from whoever
 * runs it and the rendering does not, so `npm run docs` regenerates the figure
 * anywhere and CI sees a stale one.
 *
 * Run: bun eval/repetition.ts [--sessions 8] [--top 14] [--tail 120] [--publish]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { tokensIn } from '../src/compact.js';
import { commandSignature } from '../src/signals.js';

const args = process.argv.slice(2);
const num = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const SESSIONS = num('--sessions', 8);
const TOP = num('--top', 14);
/** Gaps above this are treated as a session left open, not a tool running. */
const TAIL_SECONDS = num('--tail', 120);

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    try {
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (entry.endsWith('.jsonl')) out.push(path);
    } catch { /* a session being written can vanish mid-walk */ }
  }
  return out;
}

type Gate = 'human' | 'delegated' | 'machine';
type Call = {
  shape: string; tool: string; chars: number; seconds: number; session: string; gate: Gate;
  target?: string;
};

/**
 * Who the clock was actually waiting on.
 *
 * The first run of this put `AskUserQuestion` at the top of a column headed
 * "tool time" with 89 minutes against it. No tool ran for 89 minutes: that is
 * a person deciding, and the median of 83 seconds is a person reading the
 * question. Calling it tool time would have been the same class of error as
 * publishing a modelled number as a measured one, in a table built to fix
 * exactly that. `Agent` is a third case again — a subagent working, which is
 * machine time but not time this session could have spent otherwise.
 */
const HUMAN = new Set(['AskUserQuestion', 'ExitPlanMode']);
const DELEGATED = new Set(['Agent', 'Task']);
const gateOf = (tool: string): Gate =>
  HUMAN.has(tool) ? 'human' : DELEGATED.has(tool) ? 'delegated' : 'machine';

/**
 * The shape a call belongs to, using the classifier the recorder ships.
 *
 * A `Bash` call gets its command signature, which is what collapses
 * `sed -n 1,40p foo.ts` and `sed -n 90,120p bar.ts` onto one row. Everything
 * else is grouped by tool name, which is all the recorder does with them too.
 */
function shapeOf(tool: string, input: unknown): string {
  if (tool === 'Bash') {
    const command = (input as { command?: unknown })?.command;
    if (typeof command === 'string') return `Bash(${commandSignature(command)})`;
  }
  return tool;
}

/** The text of a `tool_result` block, whichever of the two shapes it takes. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'object' && block !== null && 'text' in block
      ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('');
}

/**
 * The file a call went and read, where there is one.
 *
 * The shape table ranks the verb, and the verb is not the finding: `sed -n`
 * repeating 300 times says only that files get read. The same *file* being
 * read 189 times across five sessions is a thing a reader can act on, and the
 * action is a line in CLAUDE.md rather than a drafted skill.
 */
function targetOf(tool: string, input: unknown): string | undefined {
  const arg = input as { file_path?: unknown; command?: unknown } | undefined;
  if (typeof arg?.file_path === 'string') return arg.file_path;
  if (tool !== 'Bash' || typeof arg?.command !== 'string') return undefined;
  const match = /(?:sed -n[^|;]*|cat -n|cat|head|tail)\s+(?:[^\s|;]*\s)?([\w./-]+\.[a-z]{1,5})\b/
    .exec(arg.command);
  return match?.[1];
}

const paths = walk(join(homedir(), '.claude', 'projects'))
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, SESSIONS);

const calls: Call[] = [];
let unpaired = 0;
for (const { path } of paths) {
  const session = path.split('/').pop()!.slice(0, 8);
  const started = new Map<string, { at: number; tool: string; input: unknown }>();
  const finished: Array<{ id: string; at: number; chars: number }> = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row?.timestamp ?? '');
    const content = row?.message?.content;
    if (!Number.isFinite(at) || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        started.set(block.id, { at, tool: String(block.name ?? '?'), input: block.input });
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        finished.push({ id: block.tool_use_id, at, chars: resultText(block.content).length });
      }
    }
  }
  for (const end of finished) {
    const start = started.get(end.id);
    if (!start) { unpaired += 1; continue; }
    calls.push({
      shape: shapeOf(start.tool, start.input),
      tool: start.tool,
      chars: end.chars,
      seconds: Math.max(0, (end.at - start.at) / 1000),
      session,
      gate: gateOf(start.tool),
      target: targetOf(start.tool, start.input),
    });
  }
}

type Shape = {
  shape: string; n: number; chars: number; seconds: number; trimmed: number;
  sessions: Set<string>;
};
const shapes = new Map<string, Shape>();
for (const call of calls) {
  const row = shapes.get(call.shape) ?? {
    shape: call.shape, n: 0, chars: 0, seconds: 0, trimmed: 0, sessions: new Set<string>(),
  };
  row.n += 1;
  row.chars += call.chars;
  row.seconds += call.seconds;
  row.trimmed += Math.min(call.seconds, TAIL_SECONDS);
  row.sessions.add(call.session);
  shapes.set(call.shape, row);
}

const all = [...shapes.values()];
const repeated = all.filter((row) => row.n >= 3 && row.sessions.size >= 2);
const sum = (rows: Shape[], pick: (r: Shape) => number): number =>
  rows.reduce((total, row) => total + pick(row), 0);
const hours = (seconds: number): string => `${(seconds / 3600).toFixed(1)} h`;
const k = (n: number): string => `${Math.round(n / 1000).toLocaleString('en-GB')}k`;

console.log(`\n${calls.length.toLocaleString('en-GB')} tool calls over ${paths.length} sessions, `
  + `${all.length.toLocaleString('en-GB')} distinct shapes, ${repeated.length} repeated `
  + `(3+ times in 2+ sessions)`);
if (unpaired > 0) console.log(`${unpaired} results had no matching call and were skipped.`);
console.log(`\nwhat every call cost:        ${k(tokensIn(sum(all, (r) => r.chars)))} tokens, `
  + `${hours(sum(all, (r) => r.seconds))} of tool time `
  + `(${hours(sum(all, (r) => r.trimmed))} with gaps over ${TAIL_SECONDS}s trimmed)`);
console.log(`what the repeated ones cost: ${k(tokensIn(sum(repeated, (r) => r.chars)))} tokens, `
  + `${hours(sum(repeated, (r) => r.seconds))} of tool time `
  + `(${hours(sum(repeated, (r) => r.trimmed))} trimmed)`);

const share = (part: number, whole: number): string => `${((100 * part) / whole).toFixed(0)}%`;
console.log(`repetition is ${share(sum(repeated, (r) => r.chars), sum(all, (r) => r.chars))} of the `
  + `tokens and ${share(sum(repeated, (r) => r.trimmed), sum(all, (r) => r.trimmed))} of the time.`);

console.log('\nwho the clock was waiting on, over every call:');
for (const gate of ['machine', 'human', 'delegated'] as Gate[]) {
  const mine = calls.filter((call) => call.gate === gate);
  const raw = mine.reduce((total, call) => total + call.seconds, 0);
  const trim = mine.reduce((total, call) => total + Math.min(call.seconds, TAIL_SECONDS), 0);
  const label = gate === 'machine' ? 'a tool running'
    : gate === 'human' ? 'a person deciding' : 'a subagent working';
  console.log(`  ${label.padEnd(20)}${String(mine.length).padStart(6)} calls  `
    + `${hours(trim).padStart(7)} trimmed  (${hours(raw)} raw)`);
}

const head = `${'shape'.padEnd(42)}${'times'.padStart(7)}${'sess'.padStart(6)}`
  + `${'tokens'.padStart(10)}${'waited'.padStart(12)}${'trimmed'.padStart(10)}`
  + `${'median'.padStart(9)}`;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const byShape = new Map<string, number[]>();
for (const call of calls) {
  const seen = byShape.get(call.shape);
  if (seen) seen.push(call.seconds);
  else byShape.set(call.shape, [call.seconds]);
}

for (const [label, rank] of [
  ['by time waited', (r: Shape) => r.trimmed],
  ['by tokens poured into context', (r: Shape) => r.chars],
] as [string, (r: Shape) => number][]) {
  console.log(`\nthe repeated shapes that cost most, ${label}:`);
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const row of [...repeated].sort((a, b) => rank(b) - rank(a)).slice(0, TOP)) {
    console.log(
      `${row.shape.slice(0, 41).padEnd(42)}${String(row.n).padStart(7)}`
      + `${String(row.sessions.size).padStart(6)}`
      + `${k(tokensIn(row.chars)).padStart(10)}`
      + `${`${(row.seconds / 60).toFixed(1)}m`.padStart(12)}`
      + `${`${(row.trimmed / 60).toFixed(1)}m`.padStart(10)}`
      + `${`${median(byShape.get(row.shape) ?? []).toFixed(1)}s`.padStart(9)}`,
    );
  }
}

/**
 * The bill, by what was read rather than by what read it.
 *
 * Two files deep this stops being a curiosity: the same handful of paths are
 * rediscovered session after session, and every rediscovery is the whole file
 * arriving in context again.
 */
type Target = { path: string; reads: number; chars: number; sessions: Set<string> };
const targets = new Map<string, Target>();
for (const call of calls) {
  if (!call.target) continue;
  const key = call.target.split('/').slice(-2).join('/');
  const row = targets.get(key) ?? { path: key, reads: 0, chars: 0, sessions: new Set<string>() };
  row.reads += 1;
  row.chars += call.chars;
  row.sessions.add(call.session);
  targets.set(key, row);
}
const files = [...targets.values()];
const reread = files.filter((row) => row.reads >= 2);
const fileChars = files.reduce((total, row) => total + row.chars, 0);
const rereadChars = reread.reduce((total, row) => total + row.chars, 0);

console.log(`\n${files.length.toLocaleString('en-GB')} files were read at all. `
  + `${reread.length} of them more than once, and those `
  + `${reread.length} account for ${reread.reduce((t, r) => t + r.reads, 0).toLocaleString('en-GB')} `
  + `reads and ${k(tokensIn(rereadChars))} tokens `
  + `${share(rereadChars, fileChars)} of every token spent reading a file.`);
const fhead = `${'file'.padEnd(44)}${'reads'.padStart(7)}${'sess'.padStart(6)}${'tokens'.padStart(9)}`;
console.log(`\nthe files rediscovered most:`);
console.log(fhead);
console.log('-'.repeat(fhead.length));
for (const row of [...reread].sort((a, b) => b.chars - a.chars).slice(0, TOP)) {
  console.log(`${row.path.slice(0, 43).padEnd(44)}${String(row.reads).padStart(7)}`
    + `${String(row.sessions.size).padStart(6)}${k(tokensIn(row.chars)).padStart(9)}`);
}

console.log(`\nThis is what these shapes COST, measured. It is not what a skill would save:`);
console.log(`nothing here has measured whether a drafted skill changes any of it, and a`);
console.log(`skill does not stop you needing to read a file. The gap between the two is`);
console.log(`the whole reason this prints cost rather than savings.`);

if (args.includes('--publish')) {
  /**
   * Only what the figure draws, and no paths that are not already public.
   *
   * A read target is a path on someone's disk. These are published as the last
   * two segments, which is what the table shows, and only for files that were
   * read more than once — the whole finding. Anything with a home directory or
   * an absolute temp path in it is dropped rather than trimmed, because
   * trimming a path is exactly the kind of "probably fine" that put an
   * operator's own words in a fixture once already.
   */
  const PRIVATE = /^(?:home|Users|tmp|var|etc|root)\b|\.ssh|\.env|secret|credential/i;
  const top = [...reread]
    .sort((a, b) => b.chars - a.chars)
    .filter((row) => !PRIVATE.test(row.path))
    .slice(0, TOP)
    .map((row) => ({
      path: row.path, reads: row.reads, sessions: row.sessions.size,
      tokens: tokensIn(row.chars),
    }));
  const gates = (['machine', 'human', 'delegated'] as Gate[]).map((gate) => {
    const mine = calls.filter((call) => call.gate === gate);
    return {
      gate, calls: mine.length,
      seconds: Math.round(mine.reduce((t, c) => t + Math.min(c.seconds, TAIL_SECONDS), 0)),
    };
  });
  const fixture = {
    sessions: paths.length,
    calls: calls.length,
    tokens: tokensIn(sum(all, (r) => r.chars)),
    seconds: Math.round(sum(all, (r) => r.trimmed)),
    tailSeconds: TAIL_SECONDS,
    repeated: {
      shapes: repeated.length,
      tokens: tokensIn(sum(repeated, (r) => r.chars)),
      seconds: Math.round(sum(repeated, (r) => r.trimmed)),
    },
    files: {
      read: files.length,
      reread: reread.length,
      rereads: reread.reduce((t, r) => t + r.reads, 0),
      tokens: tokensIn(rereadChars),
      shareOfReadTokens: Number(((100 * rereadChars) / fileChars).toFixed(1)),
      top,
    },
    gates,
  };
  const out = join(import.meta.dirname, 'fixtures', 'repetition.json');
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`\nwrote ${out}: ${top.length} files, ${fixture.files.reread} reread`);
}
