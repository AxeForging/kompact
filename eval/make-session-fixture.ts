/**
 * Derives `test/fixtures/session.jsonl` from a real Claude Code transcript.
 *
 * `test/real-transcript.test.ts` guards the invariant CONTRIBUTING calls
 * load-bearing: no `tool_use` may be left without its `tool_result`, or the API
 * rejects the message list and breaks the very session compaction was meant to
 * save. It guarded nothing on a runner, because it needs `~/.claude/projects`
 * and silently skipped — CI ran 61 of 66 tests and said it was green.
 *
 * No hand-written fixture exercises the shapes that make the invariant hard:
 * results that arrived as an error, thinking blocks, results whose content is an
 * array of blocks rather than a string, and a file made *entirely* of sidechain
 * rows — a subagent's own transcript, which the unconditional sidechain skip
 * would throw away whole. So this keeps the real structure — row order, types,
 * ids, block placement, text lengths — and replaces every character of content
 * with filler.
 *
 * Two fixtures, because one session cannot hold both: `session.jsonl` is a main
 * conversation and `subagent.jsonl` is an all-sidechain one. Nothing here covers
 * several tool calls in one assistant message; no transcript on this machine has
 * any, so there is nothing to derive one from.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FILLER = 'abcdefghijklmnopqrstuvwxyz';
/** Above the 20,000-char "very long" bucket, so capping keeps every size class. */
const MAX_CHARS = 24_000;
let cursor = 0;
/** Same length, same whitespace and newlines, none of the content. */
const scrub = (text: string): string =>
  text.slice(0, MAX_CHARS).replace(/\S/g, () => FILLER[cursor++ % FILLER.length]!);

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v)]));
  }
  return value;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (entry.endsWith('.jsonl')) out.push(path);
    } catch { /* a session being written can vanish mid-walk */ }
  }
  return out;
}

const transcripts = walk(join(homedir(), '.claude', 'projects'))
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((a, b) => b.size - a.size);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

function derive(name: string, source: string, wanted: number): void {
  const rows = readFileSync(source, 'utf8').split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => { try { return [JSON.parse(line) as any]; } catch { return []; } });

  const out: unknown[] = [];
  let uses = 0;
  let errors = 0;
  let sidechains = 0;
  let arrayResults = 0;
  for (const row of rows) {
    if (row.type !== 'assistant' && row.type !== 'user') continue;
    const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
    uses += blocks.filter((b: any) => b?.type === 'tool_use').length;
    errors += blocks.filter((b: any) => b?.is_error === true).length;
    arrayResults += blocks.filter((b: any) => b?.type === 'tool_result' && Array.isArray(b.content)).length;
    if (row.isSidechain) sidechains += 1;
    // Only the fields `readTranscript` reads survive; everything else — cwd, git
    // branch, timestamps, uuids, the user's own paths — is left behind.
    out.push({
      type: row.type,
      ...(row.isSidechain ? { isSidechain: true } : {}),
      message: {
        content: typeof row.message?.content === 'string'
          ? scrub(row.message.content)
          : blocks.map((block: any) => {
            if (block?.type === 'tool_use') {
              return { type: 'tool_use', id: block.id, name: block.name, input: scrubValue(block.input ?? {}) };
            }
            if (block?.type === 'tool_result') {
              return {
                type: 'tool_result', tool_use_id: block.tool_use_id,
                content: scrubValue(block.content ?? ''),
                ...(block.is_error === true ? { is_error: true } : {}),
              };
            }
            if (block?.type === 'thinking') return { type: 'thinking', thinking: scrub(block.thinking ?? '') };
            if (block?.type === 'text') return { type: 'text', text: scrub(block.text ?? '') };
            return { type: String(block?.type ?? 'unknown') };
          }),
      },
    });
    if (uses >= wanted) break;
  }

  // Stopping mid-flight leaves the last call's result on the cutting-room floor,
  // and a fixture that arrives already orphaned cannot prove anything about
  // whether compaction creates orphans. Drop trailing rows until it is paired.
  const idsOf = (row: any, kind: string, key: string): string[] =>
    (Array.isArray(row.message?.content) ? row.message.content : [])
      .filter((b: any) => b?.type === kind).map((b: any) => b[key] as string);
  for (;;) {
    const used = new Set(out.flatMap((row) => idsOf(row, 'tool_use', 'id')));
    for (const row of out) for (const id of idsOf(row, 'tool_result', 'tool_use_id')) used.delete(id);
    if (used.size === 0 || out.length === 0) break;
    out.pop();
  }

  const serialised = out.map((row) => JSON.stringify(row)).join('\n') + '\n';
  for (const [what, pattern] of [
    ['an absolute path', /\/home\/|\/Users\//],
    ['an email address', /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
  ] as const) {
    const hit = pattern.exec(serialised);
    if (hit) throw new Error(`${name} still contains ${what}: ${JSON.stringify(hit[0])}`);
  }
  writeFileSync(join(fixtures, name), serialised);
  console.log(`wrote ${name}: ${out.length} rows, ${uses} tool calls, ${errors} errors, ` +
    `${arrayResults} array-content results, ${sidechains} sidechain rows, ` +
    `${(serialised.length / 1024).toFixed(0)} KB`);
}

const main = transcripts.find((t) => !t.path.includes('/agent-'));
const subagent = transcripts.filter((t) => t.path.includes('/agent-')).at(-1);
if (!main || !subagent) throw new Error('need one main and one subagent transcript to derive fixtures from');
derive('session.jsonl', main.path, 40);
derive('subagent.jsonl', subagent.path, 8);
