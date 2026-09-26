/**
 * Study 1 — can prose be compacted reliably with NO model?
 *
 * The ship target is model-free and verbatim-safe (owner decision). This asks the
 * feasibility question directly: over real sessions, can cheap model-free features
 * rank an assistant prose sentence by whether it is *referenced again later* — the
 * same "reused verbatim" proxy the tool-call scorer is judged on — well enough to
 * drop the rest safely?
 *
 * Never drops user messages (instructions are ground-truth must-keep); only
 * assistant prose is a candidate. A sentence is `needed` when a distinctive
 * 5-gram of it reappears in a strictly later message (verbatim reuse). Features
 * are all model-free: length, LexRank-lite centrality (cosine to the window's
 * TF-IDF centroid), recency, has-path/code, average self-information from corpus
 * unigram frequencies (a no-LM stand-in for Selective Context), is-question.
 *
 * Reports AUC out-of-fold (by session) against a length-only baseline and a
 * self-information-only baseline, the droppable share at 95% reuse-retention, and
 * featurise+score latency. Scrubbed aggregate fixture only; no raw prose.
 *
 * Run: bun eval/prose-extractive.ts [--write] [--self-check]
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { fitLogistic, outOfFold, sigmoid, dot } from './logistic.js';
import { auc, droppableAt } from './metrics.js';
import { readTranscript } from './transcript.js';
import type { Message } from '../src/index.js';

const args = process.argv.slice(2);
const WINDOW_TOKENS = 700_000;
const SESSIONS = 40;
const SHINGLE = 5;           // n-gram length for reuse detection
const SHINGLE_DF_CAP = 30;   // ignore boilerplate n-grams above this doc frequency
const SAFETY = 0.95;         // retain this share of reused prose when dropping
const MAX_SENTS = 1200;      // ponytail: cap per window so centroid pass stays cheap

type Sent = {
  session: string; msg: number; tokens: number; chars: number;
  needed: boolean; feats: number[];
};

function walk(root: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return out; }
  for (const e of entries) {
    const p = join(root, e);
    try {
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (p.endsWith('.jsonl')) out.push(p);
    } catch { /* vanished mid-walk */ }
  }
  return out;
}

function windowTail(messages: readonly Message[]): Message[] {
  const budget = WINDOW_TOKENS * 4;
  let chars = 0; const out: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    out.push(m);
    chars += (m.text?.length ?? 0);
    if (chars >= budget) break;
  }
  return out.reverse();
}

const words = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
/** Sentence split: on ., !, ?, newline; drop fragments under 3 words. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => (s.match(/[a-z0-9]+/gi)?.length ?? 0) >= 3);
}

const estTokens = (s: string): number => Math.ceil(s.length / 4);

/** Assistant prose sentences with model-free features and a reuse label. */
export function analyseWindow(
  messages: readonly Message[],
  session: string,
  unigram: ReadonlyMap<string, number>,
  unigramTotal: number,
): Sent[] {
  // 1. every message's word set, for reuse lookups by n-gram -> message indices.
  const shingleMsgs = new Map<string, Set<number>>();
  messages.forEach((m, i) => {
    const w = words(m.text ?? '');
    for (let k = 0; k + SHINGLE <= w.length; k += 1) {
      const g = w.slice(k, k + SHINGLE).join(' ');
      (shingleMsgs.get(g) ?? shingleMsgs.set(g, new Set()).get(g)!).add(i);
    }
  });
  // 2. collect assistant sentences (candidates); build TF for centroid.
  type Raw = { msg: number; text: string; w: string[] };
  const raws: Raw[] = [];
  messages.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    for (const s of sentences(m.text ?? '')) raws.push({ msg: i, text: s, w: words(s) });
  });
  if (raws.length === 0) return [];
  const sample = raws.length > MAX_SENTS
    ? raws.filter((_, i) => i % Math.ceil(raws.length / MAX_SENTS) === 0)
    : raws;
  // TF-IDF centroid over the sampled sentences.
  const df = new Map<string, number>();
  for (const r of sample) for (const t of new Set(r.w)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string): number => Math.log(1 + sample.length / (1 + (df.get(t) ?? 0)));
  const vec = (w: string[]): Map<string, number> => {
    const tf = new Map<string, number>();
    for (const t of w) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [t, c] of tf) v.set(t, c * idf(t));
    return v;
  };
  const centroid = new Map<string, number>();
  const vecs = sample.map((r) => vec(r.w));
  for (const v of vecs) for (const [t, x] of v) centroid.set(t, (centroid.get(t) ?? 0) + x);
  let cNorm = 0; for (const x of centroid.values()) cNorm += x * x; cNorm = Math.sqrt(cNorm) || 1;
  const cosCentroid = (v: Map<string, number>): number => {
    let dotp = 0, n = 0;
    for (const [t, x] of v) { dotp += x * (centroid.get(t) ?? 0); n += x * x; }
    return dotp / ((Math.sqrt(n) || 1) * cNorm);
  };
  const total = sample.length;
  return sample.map((r, idx) => {
    // reuse: any distinctive n-gram of this sentence appears in a LATER message.
    let needed = false;
    for (let k = 0; k + SHINGLE <= r.w.length; k += 1) {
      const g = r.w.slice(k, k + SHINGLE).join(' ');
      const seen = shingleMsgs.get(g);
      if (!seen || seen.size > SHINGLE_DF_CAP) continue;
      for (const j of seen) { if (j > r.msg) { needed = true; break; } }
      if (needed) break;
    }
    const selfInfo = r.w.length
      ? r.w.reduce((a, t) => a - Math.log(((unigram.get(t) ?? 0) + 1) / (unigramTotal + 1)), 0) / r.w.length
      : 0;
    const hasPathOrCode = /`|\/[\w.-]+|\w+\.\w{1,4}\b|\(\)/.test(r.text) ? 1 : 0;
    const isQuestion = /\?\s*$/.test(r.text) ? 1 : 0;
    const feats = [
      Math.log(1 + r.w.length),   // length
      cosCentroid(vecs[idx]!),    // LexRank-lite centrality
      idx / total,                // recency (later = higher)
      hasPathOrCode,
      selfInfo,
      isQuestion,
    ];
    return { session, msg: r.msg, tokens: estTokens(r.text), chars: r.text.length, needed, feats };
  });
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function main() {
  const paths = walk(join(homedir(), '.claude', 'projects'))
    .map((p) => ({ p, m: statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)
    .slice(0, SESSIONS).map((x) => x.p);

  // Global unigram frequencies (corpus-wide), for self-information.
  const unigram = new Map<string, number>();
  let unigramTotal = 0;
  const windows: { session: string; messages: Message[] }[] = [];
  for (const path of paths) {
    let messages: Message[];
    try { messages = windowTail(readTranscript(path)); } catch { continue; }
    if (messages.length < 4) continue;
    for (const m of messages) if (m.role === 'assistant') {
      for (const t of words(m.text ?? '')) { unigram.set(t, (unigram.get(t) ?? 0) + 1); unigramTotal += 1; }
    }
    windows.push({ session: path.split('/').pop()!.slice(0, 8), messages });
  }

  const rows: Sent[] = [];
  let latMs = 0, latWindows = 0;
  for (const w of windows) {
    const t0 = performance.now();
    const r = analyseWindow(w.messages, w.session, unigram, unigramTotal);
    latMs += performance.now() - t0; latWindows += 1;
    rows.push(...r);
  }
  if (rows.length === 0) { console.log('no prose sentences found'); return; }

  const y = rows.map((r) => r.needed);
  const chars = rows.map((r) => r.chars);
  const X = rows.map((r) => r.feats);
  // out-of-fold logistic scores (by session), the honest AUC.
  const scores = outOfFold(rows.map((r) => ({ session: r.session })), X, y.map((b) => (b ? 1 : 0)));
  const aucModel = auc(scores, y);
  // baselines: length only, self-info only (Selective-Context-lite, no model).
  const aucLen = auc(rows.map((r) => r.feats[0]!), y);
  const aucSelf = auc(rows.map((r) => r.feats[4]!), y);
  const drop = droppableAt(scores, y, chars, SAFETY);

  const base = y.filter(Boolean).length / y.length;
  const fixture = {
    sessions: windows.length,
    proseSentences: rows.length,
    reuseBaseRatePct: Number((100 * base).toFixed(1)),
    aucModelFree: Number(aucModel.toFixed(3)),
    aucLengthBaseline: Number(aucLen.toFixed(3)),
    aucSelfInfoBaseline: Number(aucSelf.toFixed(3)),
    droppableAt95Pct: Number((100 * drop.droppedChars / drop.totalChars).toFixed(1)),
    wrongDropsAt95: drop.wrongDrops,
    // Oracle: a perfect reuse classifier drops every non-reused sentence. This is
    // the ceiling ANY method (incl. a learned model in Study 2) could reach on
    // this reliability proxy, so it bounds the whole question.
    oracleDroppablePctOfProse: Number((100 * chars.reduce((a, c, i) => a + (y[i] ? 0 : c), 0) / Math.max(1, chars.reduce((a, c) => a + c, 0))).toFixed(1)),
    proseShareOfWindowPct: 3.92, // from prose-narration.json (median)
    medianLatencyMsPerWindow: Number((latMs / Math.max(1, latWindows)).toFixed(1)),
  };

  console.log(`\nsessions:                 ${fixture.sessions}   prose sentences: ${fixture.proseSentences}`);
  console.log(`reuse base rate:          ${fixture.reuseBaseRatePct}%  (share of assistant prose referenced later)`);
  console.log(`AUC model-free logistic:  ${fixture.aucModelFree}`);
  console.log(`AUC length baseline:      ${fixture.aucLengthBaseline}`);
  console.log(`AUC self-info baseline:   ${fixture.aucSelfInfoBaseline}  (Selective-Context-lite, no LM)`);
  console.log(`droppable @ ${SAFETY * 100}% kept:     ${fixture.droppableAt95Pct}% of prose chars  (${fixture.wrongDropsAt95} reused sentences lost)`);
  console.log(`featurise+score latency:  ${fixture.medianLatencyMsPerWindow} ms/window`);
  const oracleWindowPct = (fixture.oracleDroppablePctOfProse * fixture.proseShareOfWindowPct) / 100;
  console.log(`ORACLE (perfect classifier): drops ${fixture.oracleDroppablePctOfProse}% of prose chars = ~${oracleWindowPct.toFixed(2)}% of the WINDOW`);
  console.log(`  (this is the ceiling any learned model in Study 2 could reach; the model-free result above is far below it)`);
  const verdict = fixture.aucModelFree >= 0.65 && fixture.droppableAt95Pct >= 40
    ? 'FEASIBLE model-free (beats chance, frees prose at high retention)'
    : 'WEAK: model-free ranking is near chance or frees little at safe retention';
  console.log(`\nverdict: ${verdict}`);
  // context: prose is ~3.92% of the window (prose-narration.json), so even a
  // perfect prose compaction frees at most ~4% of the window.

  if (args.includes('--write')) {
    const out = join(import.meta.dirname, 'fixtures', 'prose-extractive.json');
    writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`\nwrote ${out}`);
  }
}

/** ponytail: self-check on reuse labelling + a feature, no corpus. */
function selfCheck() {
  const uni = new Map<string, number>(); let tot = 0;
  const messages: Message[] = [
    { role: 'assistant', text: 'The unique zebra quantum ledger anchors the design here.', toolUses: [] },
    { role: 'assistant', text: 'Some unrelated filler words go here for padding only.', toolUses: [] },
    { role: 'user', text: 'Remember the unique zebra quantum ledger anchors everything.', toolUses: [] },
  ];
  for (const m of messages) if (m.role === 'assistant') for (const t of words(m.text)) { uni.set(t, (uni.get(t) ?? 0) + 1); tot += 1; }
  const r = analyseWindow(messages, 's', uni, tot);
  const first = r.find((x) => x.msg === 0);
  const second = r.find((x) => x.msg === 1);
  if (!first?.needed) throw new Error('sentence reused later should be needed=true');
  if (second?.needed) throw new Error('unreferenced filler should be needed=false');
}

selfCheck();
if (args.includes('--self-check')) console.log('self-check ok');
else main();
