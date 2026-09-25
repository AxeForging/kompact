/**
 * Which labelled corpus a script reads.
 *
 * `labels.jsonl` is derived from the operator's own sessions and cannot be
 * committed — it holds verbatim tool output and an email address. The scrubbed
 * `fixtures/labels.jsonl` can, and `eval/make-fixture.ts` proves the two produce
 * a bit-identical feature matrix, so a run on either reports the same AUC. So a
 * runner with no private data measures the same thing this machine does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LabelRow } from './extract-labels.js';

/**
 * A row's identity. Not `tool_use_id` alone: one Agent call in the corpus is
 * recorded twice, once in the parent session and once in the subagent's own
 * transcript, under the same id. Keying a feature or score cache by the id alone
 * silently gave one of those two rows the other's features.
 */
export const rowKey = (row: { session: string; tool_use_id: string }): string =>
  `${row.session}\u0000${row.tool_use_id}`;

export function loadCorpus(dir: string): { rows: LabelRow[]; from: string } {
  const forced = process.argv.includes('--fixture');
  const priv = join(dir, 'labels.jsonl');
  const path = !forced && existsSync(priv) ? priv : join(dir, 'fixtures', 'labels.jsonl');
  const rows = readFileSync(path, 'utf8')
    .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as LabelRow);
  return { rows, from: path.endsWith('fixtures/labels.jsonl') ? 'fixture' : 'local labels' };
}
