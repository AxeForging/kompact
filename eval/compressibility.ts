/**
 * Study 23 — is compressibility / encoding a reuse signal? (the hex/compress idea)
 *
 * Encoded blobs (base64, hex dumps, data-URIs), hashes and minified data are often
 * large yet rarely reused verbatim — the model references meaning, not a blob. A
 * tool output's gzip compression ratio is a model-free way to spot them: encoded or
 * random content barely compresses (ratio → 1), ordinary prose and logs compress
 * well (ratio well below 1). If high-entropy outputs are a big share of characters
 * and rarely needed, a feature or guard could free a lot safely.
 *
 * This is the CHEAP SCREEN: it measures gzip-ratio on the `state` snippet the corpus
 * carries (the full raw output is not stored — same wall Study 20 hit), plus a
 * base64/hex-run detector. If the signal is there, the real version adds a
 * gzip-ratio column in eval/extract-labels.ts (which holds the raw text) and refits.
 * Anchors: "Less is More: Parameter-Free Text Classification with Gzip"
 * (arXiv:2212.09410); Normalized Compression Distance.
 *
 * Reproducible: committed fixture, no model. Run: bun eval/compressibility.ts [--fixture] [--write]
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { featureVector, score, KEEP_RESULT_WEIGHTS } from '../src/features.js';
import { loadCorpus } from './corpus.js';

function auc(values: number[], labels: boolean[]): number {
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  let rankSum = 0, pos = 0, i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length && values[order[j]!]! === values[order[i]!]!) j += 1;
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k += 1) if (labels[order[k]!]) { rankSum += avgRank; pos += 1; }
    i = j;
  }
  const neg = labels.length - pos;
  return pos === 0 || neg === 0 ? 0.5 : (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

function pearson(a: number[], b: number[]): number {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) { const x = a[i]! - ma, y = b[i]! - mb; num += x * y; da += x * x; db += y * y; }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

// gzip ratio of a string: compressed bytes / raw bytes. Near 1 = incompressible
// (high entropy: encoded/random); well below 1 = repetitive/ordinary text. Tiny
// strings carry gzip's ~20-byte header, so guard the denominator.
const gzipRatio = (s: string): number => {
  const raw = Buffer.byteLength(s);
  if (raw < 32) return 1; // too short to judge; treat as incompressible-neutral
  return Math.min(1, gzipSync(Buffer.from(s)).length / raw);
};
// Share of the text that is a long base64/hex run — a direct encoded-blob signal.
const encodedShare = (s: string): number => {
  if (!s) return 0;
  let enc = 0;
  for (const m of s.matchAll(/[A-Za-z0-9+/]{40,}={0,2}|[0-9a-fA-F]{40,}/g)) enc += m[0].length;
  return enc / s.length;
};

function main() {
  const args = process.argv.slice(2);
  const { rows, from } = loadCorpus(import.meta.dirname, { fixtureOnly: args.includes('--fixture') });
  const labels = rows.map((r) => r.result_needed);
  const ratio = rows.map((r) => gzipRatio(r.state));
  const encoded = rows.map((r) => encodedShare(r.state));
  const scores = rows.map((r) => score(KEEP_RESULT_WEIGHTS, featureVector(r.state, r.tool, r.is_error)));

  const ratioAuc = auc(ratio, labels);
  const encodedAuc = auc(encoded, labels);
  const corr = pearson(ratio, scores);

  // Droppable mass: the least-compressible quartile (highest gzip-ratio). What
  // share of all output characters do they hold, and how often are they needed?
  const sorted = [...ratio].sort((a, b) => a - b);
  const q75 = sorted[Math.floor(0.75 * (sorted.length - 1))]!;
  let hiChars = 0, hiNeeded = 0, hiN = 0, totalChars = 0;
  rows.forEach((r, i) => {
    totalChars += r.output_chars;
    if (ratio[i]! >= q75) { hiN += 1; hiChars += r.output_chars; if (r.result_needed) hiNeeded += 1; }
  });
  const hiCharShare = totalChars ? hiChars / totalChars : 0;
  const hiReuse = hiN ? hiNeeded / hiN : 0;
  const baseReuse = labels.filter(Boolean).length / rows.length;

  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  console.log(`corpus (${from}): ${rows.length} calls, ${labels.filter(Boolean).length} needed`);
  console.log(`NOTE: ratio is of the stored state snippet, not the full raw output.\n`);
  console.log(`gzip-ratio AUC vs needed:     ${ratioAuc.toFixed(3)}  (0.50 = no signal)`);
  console.log(`encoded-run share AUC:        ${encodedAuc.toFixed(3)}`);
  console.log(`gzip-ratio vs score corr:     ${corr.toFixed(3)}`);
  console.log(`least-compressible quartile:  ${pct(hiCharShare)} of output chars, reuse ${pct(hiReuse)} vs ${pct(baseReuse)} overall`);

  // Worth pursuing if compressibility ranks need on its own AND the incompressible
  // mass is both large and reused below the base rate (so dropping it is cheap and
  // safe). Otherwise the state-snippet proxy found nothing — recommend the raw-text
  // version before concluding, since the proxy is weak by construction.
  const ranks = Math.abs(ratioAuc - 0.5) >= 0.03 || Math.abs(encodedAuc - 0.5) >= 0.03;
  const droppable = hiCharShare >= 0.15 && hiReuse <= baseReuse;
  const verdict = ranks && droppable
    ? `WORTH THE RAW-TEXT VERSION: even on the state snippet, low-compressibility content ranks need `
      + `(gzip AUC ${ratioAuc.toFixed(3)}, encoded AUC ${encodedAuc.toFixed(3)}) and the least-compressible quartile is `
      + `${pct(hiCharShare)} of characters reused only ${pct(hiReuse)} (vs ${pct(baseReuse)}). Add a gzip-ratio column in `
      + `extract-labels.ts, refit, and judge on freed@retention — there may be a cheap, safe win here.`
    : `INCONCLUSIVE ON THE PROXY: on the stored snippet, compressibility ${ranks ? 'ranks need a little' : 'does not rank need'} `
      + `(gzip AUC ${ratioAuc.toFixed(3)}, encoded AUC ${encodedAuc.toFixed(3)}) and the incompressible quartile holds `
      + `${pct(hiCharShare)} of chars at ${pct(hiReuse)} reuse. The snippet is a weak proxy (mostly kompact's own prose, `
      + `the blob often truncated out), so this neither confirms nor kills the idea — the raw-text column in `
      + `extract-labels.ts is the test that would. Not worth a refit on this evidence alone.`;
  console.log(`\nverdict: ${verdict}`);

  const r3 = (x: number) => Number(x.toFixed(3));
  const fixture = {
    calls: rows.length, needed: labels.filter(Boolean).length,
    gzipAuc: r3(ratioAuc), encodedAuc: r3(encodedAuc), correlation: r3(corr),
    hiQuartile: { charShare: Number((100 * hiCharShare).toFixed(1)), reuse: Number((100 * hiReuse).toFixed(1)),
      baseReuse: Number((100 * baseReuse).toFixed(1)) },
    proxy: 'state snippet, not raw output', verdict,
  };
  if (args.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'compressibility.json'),
      JSON.stringify(fixture, null, 2) + '\n');
    console.log('\nwrote fixtures/compressibility.json');
  }
  return { ratioAuc, encodedAuc, hiCharShare };
}

if (import.meta.main) {
  const { ratioAuc, encodedAuc, hiCharShare } = main();
  console.assert(ratioAuc >= 0 && ratioAuc <= 1 && encodedAuc >= 0 && encodedAuc <= 1, 'AUC out of range');
  console.assert(hiCharShare >= 0 && hiCharShare <= 1, 'quartile char share out of range');
}
