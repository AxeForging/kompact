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

/** One checkpoint+wording's cached answers for a row. */
export interface CachedScore { result: number; call: number }

/**
 * The Laya answers `eval/score.ts` recorded, for `repeat.ts` and `baseline.ts`.
 *
 * Both files exist because neither alone works. The private `scores.json` is
 * keyed by `tool_use_id`, which collapses the one call that appears in two
 * sessions — 1,062 entries for 1,063 rows — and it is gitignored anyway, so on a
 * clone every Laya row silently vanished and the published 0.721 was text in a
 * markdown file and nothing more. The committed fixture is keyed by `rowKey` and
 * has an entry per row. This reads either and returns the same shape.
 */
export function loadScores(
  dir: string,
  rows: readonly { session: string; tool_use_id: string }[],
  fixtureOnly = false,
): { scores: Record<string, Record<string, CachedScore>>; from: string } {
  const forced = fixtureOnly || process.argv.includes('--fixture');
  const priv = join(dir, 'scores.json');
  const path = !forced && existsSync(priv) ? priv : join(dir, 'fixtures', 'scores.json');
  if (!existsSync(path)) return { scores: {}, from: 'no cached Laya answers' };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as
    Record<string, Record<string, Partial<CachedScore>>>;
  const scores: Record<string, Record<string, CachedScore>> = {};
  for (const [config, byKey] of Object.entries(raw)) {
    const mapped: Record<string, CachedScore> = {};
    for (const row of rows) {
      // The fixture keys by rowKey; the private file by tool_use_id. Try both,
      // so neither file needs to know which one is being read.
      const found = byKey[rowKey(row)] ?? byKey[row.tool_use_id];
      if (found?.result !== undefined && found.call !== undefined) {
        mapped[rowKey(row)] = { result: found.result, call: found.call };
      }
    }
    scores[config] = mapped;
  }
  return { scores, from: path.includes('fixtures') ? 'fixture' : 'local scores' };
}

export function loadCorpus(dir: string, fixtureOnly = false): { rows: LabelRow[]; from: string } {
  const forced = fixtureOnly || process.argv.includes('--fixture');
  const priv = join(dir, 'labels.jsonl');
  const path = !forced && existsSync(priv) ? priv : join(dir, 'fixtures', 'labels.jsonl');
  const rows = readFileSync(path, 'utf8')
    .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as LabelRow);
  return { rows, from: path.endsWith('fixtures/labels.jsonl') ? 'fixture' : 'local labels' };
}
