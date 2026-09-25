/**
 * Is a decision model needed at all?
 *
 * Before paying for a fine-tune, measure what the cheap features already
 * available at compaction time can do on their own: the tool name, the output
 * size, how far back the call sits, whether it errored, whether a later call
 * changed the same target, whether the same target was read again. All of those
 * are computed in `state.ts` with no model call.
 *
 * Held out by session, because calls inside one session are correlated.
 *
 * Run: bun eval/baseline.ts
 */
import { dot, fitLogistic as fit, sigmoid } from './logistic.js';
import { loadCorpus, loadScores, rowKey } from './corpus.js';
import { auc, droppableAt } from './metrics.js';
import type { LabelRow } from './extract-labels.js';

const dir = import.meta.dirname;
const { rows, from } = loadCorpus(dir);
console.log(`corpus (${from}): ${rows.length} calls\n`);

/** Features are read back out of the state prose the model was given, so the
 * baseline sees exactly the same information and nothing more. */
function features(row: LabelRow): number[] {
  const s = row.state;
  const tool = row.tool;
  return [
    1,
    tool === 'Read' ? 1 : 0,
    tool === 'Bash' ? 1 : 0,
    tool === 'Edit' || tool === 'Write' ? 1 : 0,
    tool === 'Grep' || tool === 'Glob' ? 1 : 0,
    row.is_error ? 1 : 0,
    s.includes('changed afterwards') ? 1 : 0,
    s.includes('again later') ? 1 : 0,
    s.includes('very short') ? 1 : 0,
    s.includes('The output was short.') ? 1 : 0,
    s.includes('very long') ? 1 : 0,
    s.includes('long ago in the session') ? 1 : 0,
    s.includes('just now') ? 1 : 0,
  ];
}



const sessions = [...new Set(rows.map((r) => r.session))];
console.log(`rows ${rows.length}  positives ${rows.filter((r) => r.result_needed).length}  sessions ${sessions.length}\n`);

/** Leave-one-session-out predictions, so nothing is scored on its own training data. */
const oof = new Map<string, number>();
for (const heldOut of sessions) {
  const train = rows.filter((r) => r.session !== heldOut);
  const test = rows.filter((r) => r.session === heldOut);
  if (train.length === 0 || test.length === 0) continue;
  const w = fit(train.map(features), train.map((r) => (r.result_needed ? 1 : 0)));
  for (const row of test) {
    oof.set(rowKey(row), sigmoid(features(row).reduce((s, v, j) => s + v * w[j]!, 0)));
  }
}

const y = rows.map((r) => r.result_needed);
const chars = rows.map((r) => r.output_chars);

/**
 * A dropped result is not deleted outright: `truncateHeadChars` keeps its first
 * 300 characters and the assistant can re-run the tool. So 100% safety is the
 * wrong bar — the sweep below reports several, and 90% is a defensible product
 * setting where a miss costs a re-run, not lost work.
 */
const SAFETIES = [1.0, 0.98, 0.95, 0.9];

function report(name: string, scores: number[], labels: boolean[] = y): void {
  const a = auc(scores, labels);
  const cells = SAFETIES.map((safety) => {
    const at = droppableAt(scores, labels, chars, safety);
    return ((100 * at.droppedChars) / at.totalChars).toFixed(1).padStart(8);
  }).join('');
  console.log(`${name.padEnd(34)}${a.toFixed(3).padStart(6)}${cells}`);
}

console.log(`${'model'.padEnd(34)}${'AUC'.padStart(6)}${SAFETIES.map((s) => `drop@${(100 * s).toFixed(0)}%`.padStart(8)).join('')}`);
console.log('-'.repeat(72));

report('always keep', rows.map(() => 1));
report('output size (bigger = keep)', rows.map((r) => Math.min(1, r.output_chars / 50_000)));
report('output size (smaller = keep)', rows.map((r) => 1 - Math.min(1, r.output_chars / 50_000)));
report('hand rule: Edit/Write+stale drop', rows.map((r) =>
  r.tool === 'Edit' || r.tool === 'Write' ? 0.1 : r.state.includes('changed afterwards') ? 0.3 : 0.9));
report('logistic on cheap features (LOSO)', rows.map((r) => oof.get(rowKey(r)) ?? 0.5));

const { scores: cache } = loadScores(dir, rows);
if (Object.keys(cache).length > 0) {
  console.log();
  for (const key of Object.keys(cache).sort()) {
    const got = cache[key]!;
    if (rows.filter((r) => got[rowKey(r)]).length < rows.length * 0.9) continue;
    report(`laya ${key}`, rows.map((r) => got[rowKey(r)]?.result ?? 0.5));
  }
}

// A model only earns its place if it beats what the features already give away.
const logistic = auc(rows.map((r) => oof.get(rowKey(r)) ?? 0.5), y);
console.log(`\nlogistic AUC ${logistic.toFixed(3)} — any Laya config must beat this to justify the sidecar.`);

// Methodology check on my own label rule. `result_needed` is a COUNT rule (>=2
// reused shingles), and a larger output owns more shingles, so it gets more
// chances to qualify. If the size signal is an artifact of that, it should
// collapse under a RATE rule, where the reused fraction is what counts.
console.log('\n--- confound check: same models, rate-based labels ---');
const rateLabels = rows.map((r) => r.sampled_shingles > 0 && r.match_shingles / r.sampled_shingles >= 0.01);
console.log(`rate-label positives ${rateLabels.filter(Boolean).length} of ${rows.length}`);
console.log(`${'model'.padEnd(34)}${'AUC'.padStart(6)}${SAFETIES.map((s) => `drop@${(100 * s).toFixed(0)}%`.padStart(8)).join('')}`);
console.log('-'.repeat(72));
report('output size (bigger = keep)', rows.map((r) => Math.min(1, r.output_chars / 50_000)), rateLabels);
report('logistic (LOSO, count-trained)', rows.map((r) => oof.get(rowKey(r)) ?? 0.5), rateLabels);
{
  const key = 'multilingual/direct';
  if (cache[key]) report(`laya ${key}`, rows.map((r) => cache[key]![rowKey(r)]?.result ?? 0.5), rateLabels);
}
