/**
 * Study 20 — does the learned scorer beat trivial baselines on freed@retention?
 *
 * Studies 11–15 keep concluding the scorer is near its ceiling for this corpus,
 * measured against oracle and against other ranking methods. The baseline missing
 * from that picture is the dumbest one: keep the most recent calls, drop the rest.
 * If a pure-recency rule retains as many needed outputs at the same freed level,
 * the thirteen-coefficient model earns nothing over `tail -n`. This frees exactly
 * what the shipped `decideAll` frees, then asks a recency rule and a random rule to
 * free the same amount and compares needed-retention.
 *
 * (The originally-pitched salient-span truncation study needs per-output character
 * offsets of the reused span, which the label corpus does not carry — only shingle
 * counts — so it would need a transcript re-read; this is the feasible, and arguably
 * more decisive, substitute: it questions the model itself, not a truncation knob.)
 *
 * Reproducible: committed fixture, shipped weights, no model. Run: bun eval/recency-baseline.ts [--fixture] [--write]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureVector, score, KEEP_RESULT_WEIGHTS, KEEP_CALL_WEIGHTS } from '../src/features.js';
import { decideAll, DEFAULT_OPTIONS } from '../src/compact.js';
import { loadCorpus } from './corpus.js';
import type { ToolCall, CallAnswer } from '../src/index.js';

function main() {
  const args = process.argv.slice(2);
  const { rows, from } = loadCorpus(import.meta.dirname, { fixtureOnly: args.includes('--fixture') });
  const feats = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
  const bySession = new Map<string, number[]>();
  rows.forEach((r, i) => { const l = bySession.get(r.session) ?? []; l.push(i); bySession.set(r.session, l); });

  let neededAll = 0, totalAll = 0;
  for (const r of rows) { totalAll += r.output_chars; if (r.result_needed) neededAll += 1; }

  // Shipped policy: the real decideAll, per session. This sets the freed target
  // the baselines must match, and the retention to beat.
  const shippedDropped = new Set<string>();
  for (const idx of bySession.values()) {
    const calls: ToolCall[] = idx.map((i) => ({
      id: rows[i]!.tool_use_id, tool_use_id: rows[i]!.tool_use_id, tool: rows[i]!.tool, input: {},
      callIndex: 0, resultIndex: 1, resultText: '', resultChars: rows[i]!.output_chars,
      isError: rows[i]!.is_error, pinned: false,
    }));
    const ans = new Map<string, CallAnswer>(idx.map((i) => [rows[i]!.tool_use_id, {
      keepResult: score(KEEP_RESULT_WEIGHTS, feats[i]!), keepCall: score(KEEP_CALL_WEIGHTS, feats[i]!),
    }]));
    for (const d of decideAll(calls, ans, DEFAULT_OPTIONS)) if (d.action !== 'keep') shippedDropped.add(d.id);
  }
  const freedChars = (dropped: Set<string>) => rows.reduce((s, r) =>
    s + (dropped.has(r.tool_use_id) ? r.output_chars : 0), 0);
  const retention = (dropped: Set<string>) => {
    let kept = 0;
    for (const r of rows) if (r.result_needed && !dropped.has(r.tool_use_id)) kept += 1;
    return kept / neededAll;
  };
  const targetFreed = freedChars(shippedDropped) / totalAll;

  // A baseline drops calls corpus-wide in `rank` order until it has freed the SAME
  // fraction of characters the shipped policy did, so retention is read at a matched
  // freed level (overshoot is at most one call's worth across the whole corpus).
  const baselineDrop = (rank: (i: number) => number): Set<string> => {
    const dropped = new Set<string>();
    const order = rows.map((_, i) => i).sort((a, b) => rank(a) - rank(b));
    let freed = 0;
    for (const i of order) {
      if (freed >= targetFreed * totalAll) break;
      dropped.add(rows[i]!.tool_use_id); freed += rows[i]!.output_chars;
    }
    return dropped;
  };

  // Recency: oldest first, by position through the session (result_index / length),
  // so sessions of different lengths are comparable. Random: a fixed-seed shuffle,
  // the "no information" floor, reported rather than guessed.
  let seed = 0x9e3779b9;
  const rnd = (i: number) => { seed = (seed * 1664525 + 1013904223 + i) >>> 0; return seed; };
  const recency = baselineDrop((i) => rows[i]!.result_index / Math.max(1, rows[i]!.messages));
  const random = baselineDrop((i) => rnd(i));

  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const R = { shipped: retention(shippedDropped), recency: retention(recency), random: retention(random) };
  const F = { shipped: freedChars(shippedDropped) / totalAll, recency: freedChars(recency) / totalAll,
    random: freedChars(random) / totalAll };

  console.log(`corpus (${from}): ${rows.length} calls, ${bySession.size} sessions, ${neededAll} needed\n`);
  console.log('policy     freed      kept/needed');
  console.log(`shipped   ${pct(F.shipped).padStart(6)}   ${pct(R.shipped).padStart(9)}`);
  console.log(`recency   ${pct(F.recency).padStart(6)}   ${pct(R.recency).padStart(9)}  (keep most recent, drop oldest)`);
  console.log(`random    ${pct(F.random).padStart(6)}   ${pct(R.random).padStart(9)}  (fixed-seed, the no-information floor)`);

  const overRecency = R.shipped - R.recency;
  const verdict = overRecency > 0.02
    ? `EARNS ITS KEEP: at the same ~${pct(F.shipped)} freed the scorer retains ${pct(R.shipped)} of needed outputs against `
      + `${pct(R.recency)} for pure recency (+${pct(overRecency)}) and ${pct(R.random)} for random — the model is doing real work.`
    : `QUESTIONABLE: pure recency retains ${pct(R.recency)} against the scorer's ${pct(R.shipped)} at matched freed `
      + `(gap ${pct(overRecency)}). On this corpus a recency rule is nearly as good — the model's edge is small.`;
  console.log(`\nverdict: ${verdict}`);

  const round = (x: number) => Number((100 * x).toFixed(1));
  const fixture = {
    calls: rows.length, sessions: bySession.size, needed: neededAll,
    shipped: { freed: round(F.shipped), kept: round(R.shipped) },
    recency: { freed: round(F.recency), kept: round(R.recency) },
    random: { freed: round(F.random), kept: round(R.random) },
    verdict,
  };
  if (args.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'recency-baseline.json'),
      JSON.stringify(fixture, null, 2) + '\n');
    console.log('\nwrote fixtures/recency-baseline.json');
  }
  return { R, F };
}

if (import.meta.main) {
  const { R, F } = main();
  // Freed is matched by construction, so the baselines free at least the target;
  // and the scorer can do no worse than random on retention at matched freed.
  console.assert(F.recency >= F.shipped - 0.02 && F.random >= F.shipped - 0.02,
    'a baseline freed materially less than the shipped target');
  console.assert(R.shipped >= R.random - 1e-9, 'the scorer retained fewer needed outputs than random');
}
