/**
 * Measures every checkpoint x phrasing against the labelled corpus.
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
import { LayaClient } from './sidecar-client.js';
import { pool, rowTokens } from '../src/compact.js';
import { inputTokens, noulAnswer, routedModel, CONTEXT_LENGTH } from '../src/request.js';
import { questionsFor } from '../src/questions.js';
import { auc, droppableAt, ece } from './metrics.js';
import type { Phrasing } from '../src/index.js';
import type { LabelRow } from './extract-labels.js';

const dir = import.meta.dirname;
const args = process.argv.slice(2);
// 8000 is `laya-serve`'s own default (LAYA_PORT). This said 8001, and since no
// npm script ran this file nobody hit it: every request failed instantly with
// "Unable to connect" and the cache silently kept whatever it already had.
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '8000';
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
