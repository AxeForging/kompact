/**
 * Study 8 — could a local, model-free archive recover the dropped outputs that matter?
 *
 * kompact drops a stale tool output betting it can be re-run; eval/recovery.ts showed
 * that bet fails for outputs nothing can reproduce. The alternative that fits kompact's
 * constraints (local, no model, no network): instead of dropping, move the verbatim
 * output to a local BM25-indexed archive and re-inject it on demand. This measures the
 * retrieval mechanism: of outputs that ARE needed verbatim later (label from
 * extract-labels: `reused`, `first_reuse_index`), does a BM25 query built from the
 * reusing message return the correct original in the top-k of the whole archive?
 *
 * Honest scope: this is the mechanism ceiling. The reusing message overlaps the output
 * verbatim BECAUSE the output was present when reused; whether the model would issue an
 * overlapping query with the content ABSENT needs a live A/B (the standing ceiling).
 * What this settles is whether keyword retrieval, if triggered, finds the right thing.
 *
 * Run: bun eval/archive-recall.ts [--write] [--self-check]
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { labelSession } from './extract-labels.js';
import { collectToolCalls } from '../src/state.js';
import { readTranscript } from './transcript.js';

const args = process.argv.slice(2);
const tok = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);

/** Minimal BM25 over a fixed corpus of documents. */
export class BM25 {
  private df = new Map<string, number>();
  private docs: { terms: Map<string, number>; len: number }[] = [];
  private avgdl = 0;
  constructor(corpus: string[], private k1 = 1.5, private b = 0.75) {
    for (const text of corpus) {
      const terms = new Map<string, number>();
      const ts = tok(text);
      for (const t of ts) terms.set(t, (terms.get(t) ?? 0) + 1);
      for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ terms, len: ts.length });
    }
    this.avgdl = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }
  /** Indices of the top-k docs for a query, best first. */
  rank(query: string, k: number): number[] {
    const N = this.docs.length;
    const qterms = new Set(tok(query));
    const scored = this.docs.map((d, i) => {
      let s = 0;
      for (const t of qterms) {
        const f = d.terms.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * d.len / this.avgdl));
      }
      return { i, s };
    });
    return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.i);
  }
}

function walk(root: string): string[] {
  const out: string[] = []; let e: string[] = [];
  try { e = readdirSync(root); } catch { return out; }
  for (const x of e) { const p = join(root, x); try { const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p)); else if (p.endsWith('.jsonl')) out.push(p);
  } catch { /* */ } }
  return out;
}

function main() {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) { console.log('no corpus'); return; }
  const today = new Date().toISOString().slice(0, 10);
  let reusedTotal = 0, hit1 = 0, hit5 = 0, sessionsWithReuse = 0;
  let archiveDocs = 0, archiveChars = 0;
  for (const path of walk(root)) {
    let messages, calls, labels;
    try {
      messages = readTranscript(path);
      calls = collectToolCalls(messages, 0);
      if (calls.length < 3) continue;
      labels = labelSession(path, path.split('/').pop()!.slice(0, 8), today);
    } catch { continue; }
    const textById = new Map(calls.map((c) => [c.tool_use_id, c.resultText ?? '']));
    // the archive: every tool output in the session (what kompact could park locally)
    const ids = calls.map((c) => c.tool_use_id);
    const corpus = ids.map((id) => textById.get(id) ?? '');
    const bm = new BM25(corpus);
    archiveDocs += corpus.length;
    archiveChars += corpus.reduce((s, t) => s + t.length, 0);
    let anyReuse = false;
    for (const row of labels) {
      if (!row.result_needed || row.first_reuse_index < 0) continue;
      const idx = ids.indexOf(row.tool_use_id);
      if (idx < 0) continue;
      anyReuse = true; reusedTotal += 1;
      // query = the message that reused it (text + tool inputs + results), the trigger.
      const m = messages[row.first_reuse_index];
      const query = m
        ? [m.text ?? '', ...m.toolUses.map((t) => JSON.stringify(t.input ?? {})),
           ...(m.toolResults ?? []).map((r) => r.text ?? '')].join(' ')
        : '';
      const top = bm.rank(query, 5);
      if (top[0] === idx) hit1 += 1;
      if (top.includes(idx)) hit5 += 1;
    }
    if (anyReuse) sessionsWithReuse += 1;
  }

  const fixture = {
    sessionsWithReuse,
    reusedOutputs: reusedTotal,
    recallAt1Pct: reusedTotal ? Number((100 * hit1 / reusedTotal).toFixed(1)) : 0,
    recallAt5Pct: reusedTotal ? Number((100 * hit5 / reusedTotal).toFixed(1)) : 0,
    archiveDocs, archiveMedianCharsPerDoc: archiveDocs ? Math.round(archiveChars / archiveDocs) : 0,
  };
  console.log(`\nsessions with a reused output: ${fixture.sessionsWithReuse}`);
  console.log(`reused outputs (needed verbatim later): ${fixture.reusedOutputs}`);
  console.log(`BM25 archive recall@1: ${fixture.recallAt1Pct}%   recall@5: ${fixture.recallAt5Pct}%`);
  console.log(`archive size: ${fixture.archiveDocs} docs, ~${fixture.archiveMedianCharsPerDoc} chars/doc avg`);
  const strong = fixture.reusedOutputs >= 20 && fixture.recallAt5Pct >= 80;
  console.log(`\nverdict: ${fixture.reusedOutputs < 20
    ? `UNDERPOWERED: only ${fixture.reusedOutputs} reused outputs in the corpus; recall@5 ${fixture.recallAt5Pct}% is suggestive, not settled.`
    : strong
      ? `MECHANISM SOUND: a model-free BM25 archive returns the needed original in the top 5 ${fixture.recallAt5Pct}% of the time, at ms cost, no model, all local. Retrieval is not the risk; the trigger (would the model query for it) is, and that needs a live A/B.`
      : `WEAK: recall@5 ${fixture.recallAt5Pct}% — keyword retrieval misses too often; the archive would need more than BM25.`}`);
  console.log(`(Ceiling only: the query overlaps the output verbatim because it was present when reused. Realized benefit with the content absent needs a live A/B.)`);

  if (args.includes('--write')) {
    const out = join(import.meta.dirname, 'fixtures', 'archive-recall.json');
    writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`\nwrote ${out}`);
  }
}

/** ponytail: self-check BM25 retrieves the right doc from a distinctive query. */
function selfCheck() {
  const corpus = [
    "the mitochondria zebra quantum ledger anchors the design decision here",
    "ordinary filler text about lists and loops and files and tests",
    "another unrelated document mentioning servers and ports and caches",
  ];
  const bm = new BM25(corpus);
  const top = bm.rank("where did we note the zebra quantum ledger anchor", 2);
  if (top[0] !== 0) throw new Error(`BM25 top should be doc 0, got ${JSON.stringify(top)}`);
  if (bm.rank("nonexistenttermxyzzy", 2).length !== 0) throw new Error("empty query should score nothing");
}

selfCheck();
if (args.includes('--self-check')) console.log('self-check ok');
else main();
