/**
 * Phase 4 — measure every checkpoint x phrasing against the Phase 3 labels.
 *
 * Accuracy is the wrong metric: only ~10% of outputs are needed verbatim, so
 * "keep everything" already scores 90%. What matters is ranking quality (AUC)
 * and, in product terms, how much output can be dropped while still keeping
 * nearly all of what was genuinely needed — a wrong keep costs context, a wrong
 * drop destroys work that cannot be recovered.
 *
 * Run: bun eval/score.ts [--port 8001] [--limit N]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LayaClient } from '../src/client.js';
import { pool, rowTokens } from '../src/compact.js';
import { inputTokens, noulAnswer, routedModel, CONTEXT_LENGTH } from '../src/request.js';
import { questionsFor } from '../src/questions.js';
import type { Phrasing } from '../src/index.js';
import type { LabelRow } from './extract-labels.js';

const dir = import.meta.dirname;
const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '8001';
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const baseUrl = `http://127.0.0.1:${port}/v1/systemone`;

const rows: LabelRow[] = readFileSync(join(dir, 'labels.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as LabelRow)
  .slice(0, limit);

const CHECKPOINTS = ['english', 'multilingual', 'typed-decisions'];
const PHRASINGS: Phrasing[] = ['reproducible', 'direct', 'entailment'];

interface Scored { call: number; result: number; rowTokens: number; truncated: boolean }
type Cache = Record<string, Record<string, Scored>>;

const cachePath = join(dir, 'scores.json');
const cache: Cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

/** Area under the ROC curve — rank-based, so it ignores calibration. */
export function auc(scores: readonly number[], labels: readonly boolean[]): number {
  const pairs = scores.map((s, i) => ({ s, y: labels[i]! })).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1]!.s === pairs[i]!.s) j += 1;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (pairs[k]!.y) rankSum += avgRank;
    i = j + 1;
  }
  const pos = labels.filter(Boolean).length;
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Expected calibration error, 15 equal-width bins. */
export function ece(scores: readonly number[], labels: readonly boolean[], bins = 15): number {
  const counts = new Array(bins).fill(0);
  const conf = new Array(bins).fill(0);
  const acc = new Array(bins).fill(0);
  scores.forEach((s, i) => {
    const b = Math.min(bins - 1, Math.floor(s * bins));
    counts[b] += 1;
    conf[b] += s;
    acc[b] += labels[i] ? 1 : 0;
  });
  let total = 0;
  for (let b = 0; b < bins; b += 1) {
    if (counts[b] === 0) continue;
    total += (counts[b] / scores.length) * Math.abs(conf[b] / counts[b] - acc[b] / counts[b]);
  }
  return total;
}

/**
 * The product metric. Sweep the threshold down; at the lowest threshold that
 * still keeps `safety` of the genuinely-needed outputs, report the share of
 * output characters that can be dropped.
 */
export function droppableAt(
  scores: readonly number[],
  labels: readonly boolean[],
  chars: readonly number[],
  safety: number,
): { threshold: number; droppedChars: number; totalChars: number; wrongDrops: number } {
  const totalChars = chars.reduce((a, b) => a + b, 0);
  const positives = labels.filter(Boolean).length;
  let best = { threshold: 1, droppedChars: 0, totalChars, wrongDrops: positives };
  const candidates = [...new Set(scores)].sort((a, b) => a - b);
  for (const threshold of candidates) {
    let keptPositives = 0;
    let droppedChars = 0;
    let wrongDrops = 0;
    scores.forEach((s, i) => {
      const keep = s >= threshold;
      if (labels[i] && keep) keptPositives += 1;
      if (!keep) {
        droppedChars += chars[i]!;
        if (labels[i]) wrongDrops += 1;
      }
    });
    if (positives > 0 && keptPositives / positives < safety) continue;
    if (droppedChars > best.droppedChars) best = { threshold, droppedChars, totalChars, wrongDrops };
  }
  return best;
}

async function scoreConfig(checkpoint: string, phrasing: Phrasing): Promise<Record<string, Scored>> {
  const key = `${checkpoint}/${phrasing}`;
  const have = cache[key] ?? {};
  const todo = rows.filter((row) => have[row.tool_use_id] === undefined);
  if (todo.length > 0) {
    const client = new LayaClient({ model: checkpoint, baseUrl, timeoutMs: 120_000 });
    let done = 0;
    await pool(todo, 8, async (row) => {
      const call = { id: 't', tool: row.tool, input: {} } as never;
      const questions = questionsFor(call, phrasing);
      try {
        const response = await client.ask(row.state, questions);
        const used = inputTokens(response) ?? 0;
        const per = rowTokens(used, Object.keys(questions).length);
        const routed = routedModel(response) ?? checkpoint;
        have[row.tool_use_id] = {
          call: noulAnswer(response.answers, 'call_t'),
          result: noulAnswer(response.answers, 'result_t'),
          rowTokens: per,
          truncated: per >= (CONTEXT_LENGTH[routed] ?? Infinity),
        };
      } catch (error) {
        if (done === 0) console.error(`  ${key}: ${String(error).slice(0, 100)}`);
      }
      done += 1;
      if (done % 200 === 0) process.stderr.write(`  ${key} ${done}/${todo.length}\r`);
    });
    cache[key] = have;
    writeFileSync(cachePath, JSON.stringify(cache));
  }
  return have;
}

console.log(`rows ${rows.length}  positives ${rows.filter((r) => r.result_needed).length}  sidecar ${baseUrl}\n`);
const header =
  `${'checkpoint'.padEnd(16)}${'phrasing'.padEnd(14)}${'AUC'.padStart(6)}${'ECE'.padStart(7)}` +
  `${'trunc'.padStart(7)}${'thr'.padStart(7)}${'drop%'.padStart(8)}${'wrongDrops'.padStart(12)}`;
console.log(header);
console.log('-'.repeat(header.length));

const results: { key: string; auc: number; drop: number; wrong: number }[] = [];
for (const checkpoint of CHECKPOINTS) {
  for (const phrasing of PHRASINGS) {
    const scored = await scoreConfig(checkpoint, phrasing);
    const usable = rows.filter((row) => scored[row.tool_use_id] !== undefined);
    if (usable.length === 0) {
      console.log(`${checkpoint.padEnd(16)}${phrasing.padEnd(14)}  no data`);
      continue;
    }
    const s = usable.map((row) => scored[row.tool_use_id]!.result);
    const y = usable.map((row) => row.result_needed);
    const chars = usable.map((row) => row.output_chars);
    const truncated = usable.filter((row) => scored[row.tool_use_id]!.truncated).length;
    const at98 = droppableAt(s, y, chars, 0.98);
    const a = auc(s, y);
    const dropPct = (100 * at98.droppedChars) / Math.max(1, at98.totalChars);
    results.push({ key: `${checkpoint}/${phrasing}`, auc: a, drop: dropPct, wrong: at98.wrongDrops });
    console.log(
      `${checkpoint.padEnd(16)}${phrasing.padEnd(14)}${a.toFixed(3).padStart(6)}${ece(s, y).toFixed(3).padStart(7)}` +
      `${String(truncated).padStart(7)}${at98.threshold.toFixed(3).padStart(7)}${dropPct.toFixed(1).padStart(8)}${String(at98.wrongDrops).padStart(12)}`,
    );
  }
}

const best = results.filter((r) => !Number.isNaN(r.auc)).sort((a, b) => b.auc - a.auc)[0];
console.log(`\nbest by AUC: ${best?.key} (AUC ${best?.auc.toFixed(3)}, drops ${best?.drop.toFixed(1)}% of output chars at 98% safety)`);
console.log('AUC 0.5 = coin flip. Below ~0.65 zero-shot, fine-tuning is the only route to production.');
