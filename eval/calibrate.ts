/**
 * Refit the scorer on THIS machine's sessions.
 *
 * The shipped coefficients come from one person's 41 sessions. Another
 * operator's tool mix, output sizes and habits differ, so the honest default is
 * to refit locally and see whether it helps. This reports both, and only then
 * emits the weights.
 *
 *   bun eval/extract-labels.ts     # labels from your own transcripts
 *   bun eval/calibrate.ts          # report, and print the env value
 *   bun eval/calibrate.ts --write  # also write it into ~/.claude/settings.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { auc, ece } from './metrics.js';
import { dot, fitLogistic, outOfFold, sigmoid } from './logistic.js';
import { KEEP_CALL_WEIGHTS, KEEP_RESULT_WEIGHTS, WEIGHTS_ENV, featureVector } from '../src/features.js';
import type { LabelRow } from './extract-labels.js';

const dir = import.meta.dirname;
const labelsPath = join(dir, 'labels.jsonl');
if (!existsSync(labelsPath)) {
  console.error('no labels yet — run: bun eval/extract-labels.ts');
  process.exit(1);
}
const rows: LabelRow[] = readFileSync(labelsPath, 'utf8')
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LabelRow);

const sessions = new Set(rows.map((r) => r.session));
const positives = rows.filter((r) => r.result_needed).length;
console.log(`corpus: ${rows.length} calls, ${positives} needed verbatim, ${sessions.size} sessions\n`);
if (sessions.size < 3 || positives < 20) {
  console.error(
    `too thin to calibrate on (want >= 3 sessions and >= 20 positives). Keep working with\n` +
    `laya-compact installed and re-run extract-labels later; the shipped weights hold meanwhile.`,
  );
  process.exit(1);
}

const xs = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
const compare = (name: string, target: (r: LabelRow) => boolean, shipped: readonly number[]): number[] => {
  const ys = rows.map((r) => (target(r) ? 1 : 0));
  const labels = ys.map(Boolean);
  const local = outOfFold(rows, xs, ys);
  const shippedScores = xs.map((x) => sigmoid(dot(x, shipped)));
  console.log(`${name}`);
  console.log(`  shipped weights  AUC ${auc(shippedScores, labels).toFixed(3)}  ECE ${ece(shippedScores, labels).toFixed(3)}  (in-sample here if these are your sessions)`);
  console.log(`  refit here       AUC ${auc(local, labels).toFixed(3)}  ECE ${ece(local, labels).toFixed(3)}  (held out by session)`);
  const delta = auc(local, labels) - auc(shippedScores, labels);
  // The two columns are not measured the same way. For a new operator the
  // shipped column is genuinely out-of-sample and the comparison is fair; on
  // the machine the shipped weights were fitted on it is in-sample and will
  // flatter itself, so a negative delta there means nothing.
  console.log(
    `  ${delta > 0.01 ? 'refitting helps here' : 'no clear gain from refitting'}: ` +
    `${delta >= 0 ? '+' : ''}${delta.toFixed(3)} AUC (held-out minus in-sample; ` +
    `only meaningful if the shipped weights were NOT fitted on these sessions)\n`,
  );
  return fitLogistic(xs, ys);
};

const keepResult = compare('result_needed', (r) => r.result_needed, KEEP_RESULT_WEIGHTS);
const keepCall = compare('call_needed', (r) => r.call_needed, KEEP_CALL_WEIGHTS);

const weights = {
  keepResult: keepResult.map((v) => Number(v.toFixed(6))),
  keepCall: keepCall.map((v) => Number(v.toFixed(6))),
  fittedOn: `${rows.length} calls, ${sessions.size} sessions, ${new Date().toISOString().slice(0, 10)}`,
};
const value = JSON.stringify(weights);

if (!process.argv.includes('--write')) {
  console.log(`add to the "env" block of ~/.claude/settings.json:\n`);
  console.log(`  ${JSON.stringify(WEIGHTS_ENV)}: ${JSON.stringify(value)}\n`);
  console.log('or re-run with --write to do it for you.');
} else {
  const path = join(homedir(), '.claude', 'settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  settings.env = { ...(settings.env ?? {}), [WEIGHTS_ENV]: value };
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`wrote ${WEIGHTS_ENV} into ${path} — restart Claude Code to pick it up.`);
}
