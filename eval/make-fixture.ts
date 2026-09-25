/**
 * Derives `eval/fixtures/labels.jsonl` — a committed corpus, safe to publish —
 * from the private `eval/labels.jsonl`.
 *
 * `labels.jsonl` cannot be committed: its `state` field embeds the operator's
 * own prompts and verbatim tool output, absolute paths, and in at least one row
 * an email address. But without a committed corpus nothing about the shipped
 * coefficients is enforced before merge, and nobody else can reproduce a number.
 *
 * The scrub is exact rather than approximate, which is what makes the fixture
 * worth trusting: `featureVector` reads the state only through fixed phrases
 * ("The output was short.", "again later"), all of which live in template
 * sentences the scrub keeps verbatim. What it removes — the task line, the
 * target, the output excerpt — no feature reads. So the fixture is required to
 * produce a bit-identical feature matrix, and this script fails if it does not.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { featureVector } from '../src/features.js';
import { estimateTokens } from '../src/state.js';

const OUTPUT_MARKER = '\n\nThe output said:\n';
const AGE_ANCHOR = '. That happened ';

interface Row {
  session: string;
  tool_use_id: string;
  tool: string;
  target: string;
  output_chars: number;
  is_error: boolean;
  call_needed: boolean;
  result_needed: boolean;
  match_shingles: number;
  sampled_shingles: number;
  evidence: string;
  state: string;
  state_tokens: number;
  labeled_at: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const rows: Row[] = readFileSync(join(here, 'labels.jsonl'), 'utf8')
  .trimEnd().split('\n').map((line) => JSON.parse(line) as Row);

const ids = <T>(): ((key: T) => number) => {
  const seen = new Map<T, number>();
  return (key) => seen.get(key) ?? (seen.set(key, seen.size + 1), seen.size);
};
const sessionId = ids<string>();
const targetId = ids<string>();

/** `command:git status` becomes `command:command-4` — the kind, never the value. */
function scrubTarget(target: string): string {
  const kind = target.includes(':') ? target.slice(0, target.indexOf(':')) : 'target';
  return `${kind}:${kind || 'target'}-${targetId(target)}`;
}

function scrubState(row: Row, target: string): string {
  const head = row.state.split(OUTPUT_MARKER)[0]!;
  const facts = head.slice(head.indexOf('\n\n') + 2);
  const anchor = facts.indexOf(AGE_ANCHOR);
  if (anchor < 0) throw new Error(`no age sentence in ${row.tool_use_id}`);
  // Everything from the age onwards is template prose — every phrase the scorer
  // reads is in there, and none of it came from the operator's machine.
  const kept = facts.slice(anchor);
  const task = 'Task: carry on with the task.';
  const first = `The assistant ran the ${row.tool} tool on ${target}`;
  const tail = row.state.includes(OUTPUT_MARKER)
    ? `${OUTPUT_MARKER}(output withheld; ${row.output_chars} characters)`
    : '';
  return `${task}\n\n${first}${kept}${tail}`;
}

const out: Row[] = rows.map((row, index) => {
  const target = scrubTarget(row.target);
  const state = scrubState(row, target);
  return {
    ...row,
    session: `s${String(sessionId(row.session)).padStart(2, '0')}`,
    tool_use_id: `t${String(index + 1).padStart(4, '0')}`,
    target,
    state,
    state_tokens: estimateTokens(state),
    labeled_at: '',
  };
});

// The whole point: same features, or the fixture measures something else.
const same = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const drifted = rows.filter((row, i) => !same(
  featureVector(row.state, row.tool, row.is_error),
  featureVector(out[i]!.state, out[i]!.tool, out[i]!.is_error),
));
if (drifted.length > 0) {
  throw new Error(`${drifted.length} rows changed features; the scrub removed something a feature reads`);
}

// A scrub that left a path or an address behind is worse than no fixture.
const serialised = out.map((row) => JSON.stringify(row)).join('\n') + '\n';
for (const [what, pattern] of [
  ['an absolute path', /\/home\/|\/Users\//],
  ['an email address', /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
  ['a home-relative path', /~\/[\w.]/],
] as const) {
  const hit = pattern.exec(serialised);
  if (hit) throw new Error(`fixture still contains ${what}: ${JSON.stringify(hit[0])}`);
}

const path = join(here, 'fixtures', 'labels.jsonl');
writeFileSync(path, serialised);
console.log(`wrote ${path}: ${out.length} calls, ${out.filter((r) => r.result_needed).length} positives, ` +
  `${new Set(out.map((r) => r.session)).size} sessions, features bit-identical`);
