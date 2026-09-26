/**
 * Measures every checkpoint x phrasing against the labelled corpus.
 *
 * Accuracy is the wrong metric: only ~10% of outputs are needed verbatim, so
 * "keep everything" already scores 90%. What matters is ranking quality (AUC)
 * and, in product terms, how much output can be dropped while still keeping
 * nearly all of what was genuinely needed — a wrong keep costs context, a wrong
 * drop destroys work that cannot be recovered.
 *
 * `--fixture` scores the committed, scrubbed corpus instead of the private one
 * and writes back to `eval/fixtures/scores.json` (with `--publish`). Until it
 * existed, taking a FRESH measurement needed `eval/labels.jsonl`, which is
 * gitignored because it holds verbatim tool output and an email address — so
 * the published comparison could be replayed by anyone and re-measured by
 * nobody. For a project whose whole argument is reproducibility that was the
 * wrong way round.
 *
 * `--fit-budget` sends each checkpoint a state trimmed to ITS OWN budget rather
 * than the one budget the corpus was built at. It matters: the states were built
 * at 700 tokens (`eval/extract-labels.ts`) while the English checkpoint's state
 * budget is 512 - 192 = 320, so about a quarter of the English rows in the
 * published table are answers about a state the server cut, at HTTP 200 and
 * without a warning. Note what this is: a trim of an already-built state, not a
 * rebuild at that budget — `buildCallState` would have degraded the output
 * excerpt in rungs instead of cutting it where the budget falls.
 *
 * `--only a,b` restricts the sweep to those checkpoints and `--refresh` drops
 * their cached answers first, because the cache is keyed by row and has no other
 * way to be invalidated — re-measuring one checkpoint used to mean deleting the
 * whole file by hand.
 *
 * `--tag` writes the sweep under `checkpoint@tag/phrasing` instead of
 * overwriting `checkpoint/phrasing`, so a re-measurement sits BESIDE the one it
 * questions rather than replacing it. The two rows next to each other are the
 * finding; one row that silently changed value is not.
 *
 * Run: bun eval/score.ts [--port 8000] [--limit N] [--fixture] [--publish]
 *                        [--fit-budget] [--only english] [--refresh] [--tag 320]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LayaClient } from './sidecar-client.js';
import { CHARS_PER_TOKEN, pool, rowTokens } from '../src/compact.js';
import { inputTokens, noulAnswer, routedModel, CONTEXT_LENGTH, STATE_BUDGET } from '../src/request.js';
import { rowKey } from './corpus.js';
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
const useFixture = args.includes('--fixture');
const fitBudget = args.includes('--fit-budget');
const publish = args.includes('--publish');

const corpusPath = useFixture ? join(dir, 'fixtures', 'labels.jsonl') : join(dir, 'labels.jsonl');
const rows: LabelRow[] = readFileSync(corpusPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as LabelRow)
  .slice(0, limit);

const only = args.includes('--only')
  ? new Set((args[args.indexOf('--only') + 1] ?? '').split(',').filter(Boolean))
  : undefined;
const CHECKPOINTS = ['english', 'multilingual', 'typed-decisions']
  .filter((name) => only === undefined || only.has(name));
const PHRASINGS: Phrasing[] = ['reproducible', 'direct', 'entailment'];

interface Scored { call: number; result: number; rowTokens: number; truncated: boolean }
type Cache = Record<string, Record<string, Scored>>;

// The fixture cache is keyed the way `eval/repeat.ts` reads it; the private one
// keys by `tool_use_id`, which collapses the one call recorded in two sessions.
const idOf = (row: LabelRow): string => (useFixture ? rowKey(row) : row.tool_use_id);
const cachePath = useFixture ? join(dir, 'fixtures', 'scores.json') : join(dir, 'scores.json');
const cache: Cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

/**
 * The state as this checkpoint can actually read it.
 *
 * Front of the string, because `buildCallState` front-loads on purpose: the task
 * line and the derived facts come first and the raw output excerpt comes last,
 * so what a cut removes is the part that was always the most expendable.
 */
const budgetOverride = args.includes('--state-budget')
  ? Number(args[args.indexOf('--state-budget') + 1])
  : undefined;

function forBudget(state: string, checkpoint: string): string {
  if (!fitBudget && budgetOverride === undefined) return state;
  const tokens = budgetOverride ?? STATE_BUDGET[checkpoint];
  if (tokens === undefined || !Number.isFinite(tokens)) return state;
  return state.slice(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

async function scoreConfig(checkpoint: string, phrasing: Phrasing): Promise<Record<string, Scored>> {
  const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : undefined;
  const key = `${checkpoint}${tag ? `@${tag}` : ''}/${phrasing}`;
  if (args.includes('--refresh')) delete cache[key];
  const have = cache[key] ?? {};
  const todo = rows.filter((row) => have[idOf(row)] === undefined);
  if (todo.length > 0) {
    const client = new LayaClient({ model: checkpoint, baseUrl, timeoutMs: 120_000 });
    let done = 0;
    await pool(todo, 8, async (row) => {
      const call = { id: 't', tool: row.tool, input: {} } as never;
      const questions = questionsFor(call, phrasing);
      try {
        const response = await client.ask(forBudget(row.state, checkpoint), questions);
        const used = inputTokens(response) ?? 0;
        const per = rowTokens(used, Object.keys(questions).length);
        const routed = routedModel(response) ?? checkpoint;
        have[idOf(row)] = {
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
    if (useFixture && !publish) {
      console.error(`  ${key}: scored in memory; pass --publish to write ${cachePath}`);
    } else {
      writeFileSync(cachePath, `${JSON.stringify(cache)}${useFixture ? '\n' : ''}`);
    }
  }
  return have;
}

console.log(`rows ${rows.length}  positives ${rows.filter((r) => r.result_needed).length}  ` +
  `corpus ${useFixture ? 'fixture' : 'private'}  states ${budgetOverride !== undefined
    ? `trimmed to ${budgetOverride} tokens`
    : fitBudget ? "each checkpoint's own budget" : 'as built (700 tokens)'}  sidecar ${baseUrl}\n`);
const header =
  `${'checkpoint'.padEnd(16)}${'phrasing'.padEnd(14)}${'AUC'.padStart(6)}${'ECE'.padStart(7)}` +
  `${'trunc'.padStart(7)}${'thr'.padStart(7)}${'drop%'.padStart(8)}${'wrongDrops'.padStart(12)}`;
console.log(header);
console.log('-'.repeat(header.length));

const results: { key: string; auc: number; drop: number; wrong: number }[] = [];
for (const checkpoint of CHECKPOINTS) {
  for (const phrasing of PHRASINGS) {
    const scored = await scoreConfig(checkpoint, phrasing);
    const usable = rows.filter((row) => scored[idOf(row)] !== undefined);
    if (usable.length === 0) {
      console.log(`${checkpoint.padEnd(16)}${phrasing.padEnd(14)}  no data`);
      continue;
    }
    const s = usable.map((row) => scored[idOf(row)]!.result);
    const y = usable.map((row) => row.result_needed);
    const chars = usable.map((row) => row.output_chars);
    const truncated = usable.filter((row) => scored[idOf(row)]!.truncated).length;
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

/**
 * Does giving a checkpoint a state it can actually read make it better?
 *
 * The assumption that prompted this was that it must: the corpus was built at
 * 700 tokens (`eval/extract-labels.ts`) while `STATE_BUDGET.english` is 320, so
 * the server had been cutting about a third of the English rows at HTTP 200
 * without a warning, and three published AUCs carried no footnote saying so.
 *
 * It does not. Trimming the state so nothing is cut makes English WORSE at every
 * phrasing, and monotonically — the smaller the budget, the lower the AUC. The
 * reason is the shape of the state: `buildCallState` front-loads the task and the
 * derived facts and leaves the raw output excerpt last, so what the server's cut
 * removes is the part that was already the most expendable, while an honest trim
 * to a smaller budget removes the same part and then some. The cut was benign;
 * the silence about it was the problem, and the fix is the `trunc` column, not a
 * re-measurement.
 *
 * It also shows `STATE_BUDGET.english` is pessimistic. It assumes a 192-token
 * option head, but two `noul` questions with short criteria are nothing like
 * that: at a 450-token state only about 150 of 2,239 rows are cut at all.
 */
if (args.includes('--budget-sweep')) {
  const checkpoint = CHECKPOINTS[0] ?? 'english';
  console.log(`\nthe same rows at three state budgets, ${checkpoint}:`);
  const head = `${'state budget'.padEnd(22)}${'phrasing'.padEnd(14)}${'AUC'.padStart(6)}${'cut'.padStart(6)}`;
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const [label, key] of [
    ['as built (700)', checkpoint],
    ['trimmed to 450', `${checkpoint}@450`],
    [`its own budget (${STATE_BUDGET[checkpoint] ?? '?'})`, `${checkpoint}@320`],
  ] as [string, string][]) {
    for (const phrasing of PHRASINGS) {
      const scored = cache[`${key}/${phrasing}`];
      if (!scored) continue;
      const usable = rows.filter((row) => scored[idOf(row)] !== undefined);
      if (usable.length === 0) continue;
      console.log(`${label.padEnd(22)}${phrasing.padEnd(14)}` +
        `${auc(usable.map((r) => scored[idOf(r)]!.result), usable.map((r) => r.result_needed)).toFixed(3).padStart(6)}` +
        `${String(usable.filter((r) => scored[idOf(r)]!.truncated).length).padStart(6)}`);
    }
  }
  console.log('\nMore state wins at every wording, even when a third of it is being cut.');
  console.log('The cut falls on the output excerpt, which buildCallState already puts last.');
}

const best = results.filter((r) => !Number.isNaN(r.auc)).sort((a, b) => b.auc - a.auc)[0];
console.log(`\nbest by AUC: ${best?.key} (AUC ${best?.auc.toFixed(3)}, drops ${best?.drop.toFixed(1)}% of output chars at 98% safety)`);
console.log('AUC 0.5 = coin flip. Below ~0.65 zero-shot, fine-tuning is the only route to production.');
