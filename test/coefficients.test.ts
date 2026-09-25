/**
 * The shipped coefficients, checked against a committed corpus on every run.
 *
 * Twenty-six numbers sit in `src/features.ts` with nothing enforcing them:
 * transpose two and every other test stays green, because every other test
 * asserts a probability is between 0 and 1 rather than that it is the right
 * probability. `eval/fixtures/labels.jsonl` is the scrubbed corpus (see
 * `eval/make-fixture.ts`), so this runs on a CI box with no private data.
 *
 * The floors are deliberately below the measured values, not at them. A floor
 * at the measurement fails on any refit; these fail only on a change that
 * actually costs quality.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  KEEP_CALL_WEIGHTS, KEEP_RESULT_WEIGHTS, featureVector, score,
} from '../src/features.js';
import { DEFAULT_OPTIONS, decideAll, decideCall } from '../src/compact.js';
import { auc, ece } from '../eval/metrics.js';
import { loadCorpus, loadScores, rowKey } from '../eval/corpus.js';
import type { CallAnswer, ToolCall } from '../src/index.js';

interface Row {
  session: string; tool_use_id: string; tool: string; output_chars: number;
  is_error: boolean; call_needed: boolean; result_needed: boolean; state: string;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows: Row[] = readFileSync(join(root, 'eval/fixtures/labels.jsonl'), 'utf8')
  .trimEnd().split('\n').map((line) => JSON.parse(line) as Row);
const features = rows.map((row) => featureVector(row.state, row.tool, row.is_error));

describe('the shipped coefficients, on the committed corpus', () => {
  it('has the corpus the published numbers were measured on', () => {
    expect(rows).toHaveLength(2239);
    expect(rows.filter((r) => r.result_needed)).toHaveLength(247);
    expect(new Set(rows.map((r) => r.session)).size).toBe(41);
  });

  it('still ranks and is still calibrated', () => {
    const results = features.map((f) => score(KEEP_RESULT_WEIGHTS, f));
    const calls = features.map((f) => score(KEEP_CALL_WEIGHTS, f));
    expect(auc(results, rows.map((r) => r.result_needed))).toBeGreaterThan(0.80);
    expect(auc(calls, rows.map((r) => r.call_needed))).toBeGreaterThan(0.88);
    // Calibration is what makes `keepThreshold` a probability rather than a dial.
    expect(ece(results, rows.map((r) => r.result_needed))).toBeLessThan(0.08);
    expect(ece(calls, rows.map((r) => r.call_needed))).toBeLessThan(0.08);
  });

  it('still keeps most of what turned out to be needed', () => {
    const bySession = new Map<string, number[]>();
    rows.forEach((row, index) => {
      const list = bySession.get(row.session) ?? [];
      list.push(index);
      bySession.set(row.session, list);
    });

    let needed = 0;
    let kept = 0;
    let freed = 0;
    let total = 0;
    for (const indexes of bySession.values()) {
      const calls: ToolCall[] = indexes.map((i) => ({
        id: rows[i]!.tool_use_id, tool_use_id: rows[i]!.tool_use_id, tool: rows[i]!.tool,
        input: {}, callIndex: 0, resultIndex: 1, resultText: '', resultChars: rows[i]!.output_chars,
        isError: rows[i]!.is_error, pinned: false,
      }));
      const answers = new Map<string, CallAnswer>(indexes.map((i) => [
        rows[i]!.tool_use_id,
        { keepResult: score(KEEP_RESULT_WEIGHTS, features[i]!), keepCall: score(KEEP_CALL_WEIGHTS, features[i]!) },
      ]));
      const dropped = new Set(
        decideAll(calls, answers, DEFAULT_OPTIONS).filter((d) => d.action !== 'keep').map((d) => d.id),
      );
      for (const i of indexes) {
        total += rows[i]!.output_chars;
        if (dropped.has(rows[i]!.tool_use_id)) freed += rows[i]!.output_chars;
        if (!rows[i]!.result_needed) continue;
        needed += 1;
        if (!dropped.has(rows[i]!.tool_use_id)) kept += 1;
      }
    }
    // Measured at 84.6% kept and 42.5% freed; the floors leave room for a refit
    // but not for the failure this policy replaced, which kept 5%.
    expect(kept / needed).toBeGreaterThan(0.75);
    expect(freed / total).toBeGreaterThan(0.15);
  });
});

describe('a call that recorded a change is never dropped', () => {
  // Found by looking at the landing page's own demonstration: the scorer dropped
  // the Edit that fixed the bug the session was about. Its output is worthless —
  // 1 of 138 mutating calls in the corpus has one that was ever needed verbatim —
  // but its input is the only record the change happened, and re-running an Edit
  // is not a way to recover it.
  const mutating = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

  it('drops the result and keeps the call, however low both scores are', () => {
    const calls: ToolCall[] = mutating.map((tool, i) => ({
      id: `m${i}`, tool_use_id: `m${i}`, tool, input: { file_path: 'a.ts' },
      callIndex: 0, resultIndex: 1, resultText: 'Applied 1 edit', resultChars: 14,
      isError: false, pinned: false,
    }));
    for (const call of calls) {
      const decision = decideCall(call, { keepResult: 0.0001, keepCall: 0.0001 }, { keepThreshold: 0.1 });
      expect(decision.action, `${call.tool} lost its call`).toBe('drop_result');
    }
    // A read scoring the same is still dropped outright — the guard is not a
    // general softening, it is specific to information that cannot be re-fetched.
    expect(decideCall(
      { id: 'r', tool: 'Read', pinned: false },
      { keepResult: 0.0001, keepCall: 0.0001 },
      { keepThreshold: 0.1 },
    ).action).toBe('drop_call');
  });

  it('keeps every mutating call in the committed corpus', () => {
    const bySession = new Map<string, number[]>();
    rows.forEach((row, index) => {
      bySession.set(row.session, [...(bySession.get(row.session) ?? []), index]);
    });
    let dropped = 0;
    let seen = 0;
    for (const indexes of bySession.values()) {
      const calls: ToolCall[] = indexes.map((i) => ({
        id: rows[i]!.tool_use_id, tool_use_id: rows[i]!.tool_use_id, tool: rows[i]!.tool,
        input: {}, callIndex: 0, resultIndex: 1, resultText: '', resultChars: rows[i]!.output_chars,
        isError: rows[i]!.is_error, pinned: false,
      }));
      const answers = new Map<string, CallAnswer>(indexes.map((i) => [
        rows[i]!.tool_use_id,
        {
          keepResult: score(KEEP_RESULT_WEIGHTS, features[i]!),
          keepCall: score(KEEP_CALL_WEIGHTS, features[i]!),
        },
      ]));
      const actions = new Map(decideAll(calls, answers, DEFAULT_OPTIONS).map((d) => [d.id, d.action]));
      for (const i of indexes) {
        if (!mutating.includes(rows[i]!.tool)) continue;
        seen += 1;
        if (actions.get(rows[i]!.tool_use_id) === 'drop_call') dropped += 1;
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect(dropped).toBe(0);
  });
});

describe('features are read from the facts, not the echo', () => {
  // A real call in the corpus was a heredoc writing `eval/fit.ts`, whose source
  // contains "very short", "very long" and "just now". Searching the whole state
  // read three size and age features off the file being written.
  it('ignores phrases in the tool input and in the output excerpt', () => {
    const honest =
      'Task: x\n\nThe assistant ran the Bash tool with the command echo hi. ' +
      'That happened a while back. The output was long.';
    const contaminated =
      'Task: x\n\nThe assistant ran the Bash tool with the command ' +
      'cat > f.ts <<EOF if (size === "very short") return "just now"; EOF. ' +
      'That happened a while back. The output was long.' +
      '\n\nThe output said:\nsize=very long, age=just now, output was short';
    expect(featureVector(contaminated, 'Bash', false)).toEqual(featureVector(honest, 'Bash', false));
  });
});

describe('the committed fixtures reproduce the published comparison', () => {
  // The published 0.721 ± 0.021 for the best Laya checkpoint used to be text in
  // a markdown file and nothing more: `eval/scores.json` is gitignored, so on any
  // clone `repeat.ts` found no Laya rows, printed the logistic scorer alone, and
  // the paired comparison never ran. A run on the fixture now reproduces it.
  // The Laya answers cover the paired subset, not the whole corpus: sessions
  // accumulate faster than nine configurations can be scored against them.
  const paired = loadCorpus(join(root, 'eval'), { fixtureOnly: true, paired: true }).rows;

  it('carries an answer for every paired row, from every checkpoint and wording', () => {
    const { scores, from } = loadScores(join(root, 'eval'), paired, true);
    expect(from).toBe('fixture');
    expect(Object.keys(scores).length).toBe(9);
    expect(paired.length).toBeLessThan(rows.length);
    for (const [config, byKey] of Object.entries(scores)) {
      expect(Object.keys(byKey).length, `${config} is missing rows`).toBe(paired.length);
    }
  });

  it('still ranks the best Laya config where the page says it does', () => {
    const { scores } = loadScores(join(root, 'eval'), paired, true);
    const best = scores['typed-decisions/direct'];
    expect(best, 'typed-decisions/direct is the config the page quotes').toBeDefined();
    const ranked = auc(
      paired.map((r) => best![rowKey(r)]!.result),
      paired.map((r) => r.result_needed),
    );
    // In-sample over the whole corpus, so above the 0.721 held-out mean but in
    // the same place; a floor, not the published figure.
    expect(ranked).toBeGreaterThan(0.60);
    // And decisively below the shipped scorer, which is the whole argument.
    const ours = auc(
      paired.map((r) => score(KEEP_RESULT_WEIGHTS, featureVector(r.state, r.tool, r.is_error))),
      paired.map((r) => r.result_needed),
    );
    expect(ours).toBeGreaterThan(ranked + 0.1);
  });
});
