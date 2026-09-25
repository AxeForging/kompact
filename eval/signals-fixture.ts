/**
 * Does the recorder actually find anything worth proposing?
 *
 * The recorder only sees sessions from the moment it is installed, which makes
 * that question unanswerable until someone has run it for a week. This answers
 * it now by replaying transcripts that already exist through the *same*
 * functions the hook calls — `bump`, `prune` and the signatures — so what comes
 * out is what the recorder would have recorded, rather than a second
 * implementation of the same idea that could agree with nothing.
 *
 *   bun eval/signals-fixture.ts                  # report only
 *   bun eval/signals-fixture.ts --out <path>     # write a signals file
 *
 * Two things this is not. It is not the product: laya-compact does not mine your
 * transcripts, and this is not shipped as a hook. And it is not evidence that the
 * proposals are *good* — only that the repetition is real and gets found.
 * Whether a drafted skill is worth having is unmeasured, and the page says so.
 *
 * Scrub discipline, following `eval/make-fixture.ts`: a signature is redacted and
 * normalised by construction, but "by construction" is what every leak was
 * before it happened. So the output is scanned for credential shapes and this
 * fails rather than writes if one survives.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type Aggregate, bump, prune } from '../hooks/laya-signals.js';
import {
  commandSignature,
  intentSignature,
  isCorrection,
  isSequenceWorthKeeping,
  sequenceSignature,
} from '../src/signals.js';
import { collectToolCalls } from '../src/state.js';
import { readTranscript } from './transcript.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const ROOT = flag('--dir') ?? join(homedir(), '.claude', 'projects');
const OUT = flag('--out');
const LIMIT = Number(flag('--sessions') ?? 40);

/** Credential shapes that must not survive into a file anyone might commit. */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{16,}/],
  ['openai key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['aws key id', /\bAKIA[0-9A-Z]{12,}/],
  ['slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./],
  ['bearer', /\bBearer\s+[A-Za-z0-9._-]{12,}/],
  ['credentials in a url', /:\/\/[^/\s:@]+:[^/\s@]{4,}@/],
  ['long hex run', /\b[A-Fa-f0-9]{32,}\b/],
];

function sessionFiles(root: string, limit: number): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.jsonl')) files.push(join(dir, name));
    }
  }
  // Largest first: a three-line session teaches nothing about repetition.
  return files
    .map((path) => ({ path, size: statSync(path).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map((entry) => entry.path);
}

/**
 * Replays one session as the hooks would have seen it.
 *
 * A "batch" is the set of calls made in one assistant message, which is what
 * `classic.PostToolBatch` fires for. `collectToolCalls` already pairs each call
 * with its result and reports the message it was made in, so grouping on that is
 * the same partition the engine would have produced.
 */
function replay(rows: Aggregate, path: string, session: string): number {
  const messages = readTranscript(path);
  // 0, not the shipped 6: this replays what was recorded while the session ran,
  // and nothing was pinned at the time.
  const calls = collectToolCalls(messages, 0);
  const batches = new Map<number, typeof calls>();
  for (const call of calls) {
    batches.set(call.callIndex, [...(batches.get(call.callIndex) ?? []), call]);
  }

  const awaitingFix = new Set<string>();
  /** Mirrors the recorder's rolling window; see the 3-gram note there. */
  const recent: Array<{ tool: string; command?: string }> = [];
  let seen = 0;
  let lastSequence = '';
  let at = 0;

  // Prompts and batches interleave, so walk the messages in order and let each
  // do what its own hook would have done.
  for (const [index, message] of messages.entries()) {
    at += 1000;
    if (message.role === 'user' && message.text.trim() && message.toolResults === undefined) {
      const kind = seen > 0 && isCorrection(message.text) ? 'correction' : 'intent';
      bump(rows, kind, intentSignature(message.text), message.text, session, 0, 0, at);
      continue;
    }
    const batch = batches.get(index);
    if (!batch) continue;
    const steps = batch.map((call) => {
      const command = (call.input as { command?: unknown }).command;
      return typeof command === 'string' ? { tool: call.tool, command } : { tool: call.tool };
    });
    batch.forEach((call, position) => {
      const step = steps[position];
      if (!step || !('command' in step) || !step.command) return;
      const sig = commandSignature(step.command);
      bump(rows, 'command', sig, step.command, session, 1, call.resultChars, at);
      if (call.isError) awaitingFix.add(sig);
      else if (awaitingFix.delete(sig)) bump(rows, 'error-fix', sig, step.command, session, 2, 0, at);
    });
    const sequence = sequenceSignature(steps);
    recent.push(...steps);
    while (recent.length > 3) recent.shift();
    if (recent.length === 3 && isSequenceWorthKeeping(recent)) {
      bump(rows, 'sequence', sequenceSignature(recent), '', session, 3, 0, at);
    }
    if (seen === 0 && steps.length > 0) bump(rows, 'orient', sequence, '', session, steps.length, 0, at);
    seen += 1;
    lastSequence = sequence;
  }
  // The recorder does this at turn.complete; here the end of the session is the
  // only point where "last" is knowable for certain.
  if (lastSequence) bump(rows, 'verify', lastSequence, '', session, 0, 0, at);
  return calls.length;
}

const files = sessionFiles(ROOT, LIMIT);
if (files.length === 0) {
  console.log(`No sessions under ${ROOT}. Pass --dir to point somewhere else.`);
  process.exit(0);
}

let rows: Aggregate = {};
let calls = 0;
for (const [index, path] of files.entries()) {
  try {
    calls += replay(rows, path, `s${String(index + 1).padStart(2, '0')}`);
  } catch (error) {
    console.log(`skipped ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
rows = prune(rows);

const text = JSON.stringify({ version: 1, writtenAt: 0, rows }, null, 0);

// Scrub, then assert the scrub, rather than trusting the regex that did it.
const leaks = FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
if (leaks.length > 0) {
  console.error(`REFUSING TO WRITE: ${leaks.join(', ')} survived into the signatures.`);
  process.exit(1);
}

const counts = new Map<string, number>();
for (const row of Object.values(rows)) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
const repeated = Object.values(rows).filter((row) => row.n >= 3 && row.sessions.length >= 2);

console.log(`Run: ${files.length} sessions under ${ROOT}, ${calls.toLocaleString()} tool calls`);
console.log(`${Object.keys(rows).length} distinct shapes, ` +
  `${repeated.length} seen 3+ times in 2+ sessions.`);
console.log(`\n  ${'kind'.padEnd(12)}${'shapes'.padStart(8)}${'repeated'.padStart(10)}`);
for (const [kind, total] of [...counts].sort((a, b) => b[1] - a[1])) {
  const repeats = repeated.filter((row) => row.kind === kind).length;
  console.log(`  ${kind.padEnd(12)}${String(total).padStart(8)}${String(repeats).padStart(10)}`);
}
console.log(`\n  scrub: clean against ${FORBIDDEN.length} credential shapes ` +
  `(${(text.length / 1024).toFixed(0)} KiB of signatures scanned)`);

if (OUT) {
  writeFileSync(OUT, `${text}\n`);
  console.log(`\nwrote ${OUT}`);
} else {
  console.log('\nNothing written. Pass --out <path> for a signals file to run propose against.');
}
