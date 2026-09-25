/**
 * Leave-one-session-out scores, computed once and cached.
 *
 * `policy.ts`, `recovery.ts` and `outcome.ts` all need exactly the same held-out
 * scores, and each recomputed them: one logistic fit per session, 20,000
 * full-batch steps each. At 18 sessions that was tolerable. At 41 it is minutes
 * per script, three times over, and `npm run eval:ci` pays all three.
 *
 * Entries are keyed by a fingerprint of the exact inputs — the labels, the
 * feature matrix and the session of every row — so the file holds one entry per
 * corpus and can never serve scores fitted on a different one. Two corpora are
 * in routine use: the whole labelled set, and the subset every Laya
 * configuration was scored against.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { outOfFold } from './logistic.js';
import { featureVector } from '../src/features.js';
import { rowKey } from './corpus.js';
import type { LabelRow } from './extract-labels.js';

export interface OutOfFold { result: Map<string, number>; call: Map<string, number> }

/** Cheap, order-sensitive digest of the exact inputs a fit would see. */
function fingerprint(rows: readonly LabelRow[], xs: readonly number[][]): string {
  let hash = 2166136261;
  const mix = (value: number): void => {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  };
  mix(rows.length);
  rows.forEach((row, i) => {
    mix(row.result_needed ? 1 : 2);
    mix(row.call_needed ? 3 : 4);
    for (const v of xs[i]!) mix(v * 1000);
    for (let c = 0; c < row.session.length; c += 1) mix(row.session.charCodeAt(c));
  });
  return (hash >>> 0).toString(16);
}

export function outOfFoldScores(dir: string, rows: readonly LabelRow[]): OutOfFold {
  const xs = rows.map((row) => featureVector(row.state, row.tool, row.is_error));
  const stamp = fingerprint(rows, xs);
  const path = join(dir, 'fixtures', 'oof.json');

  type Entry = { result: Record<string, number>; call: Record<string, number> };
  const store: Record<string, Entry> = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Entry>)
    : {};
  const hit = store[stamp];
  if (hit) {
    return {
      result: new Map(Object.entries(hit.result)),
      call: new Map(Object.entries(hit.call)),
    };
  }

  const result = new Map<string, number>();
  const call = new Map<string, number>();
  outOfFold(rows, xs, rows.map((r) => (r.result_needed ? 1 : 0)))
    .forEach((p, i) => result.set(rowKey(rows[i]!), p));
  outOfFold(rows, xs, rows.map((r) => (r.call_needed ? 1 : 0)))
    .forEach((p, i) => call.set(rowKey(rows[i]!), p));

  store[stamp] = { result: Object.fromEntries(result), call: Object.fromEntries(call) };
  writeFileSync(path, `${JSON.stringify(store)}\n`);
  return { result, call };
}
