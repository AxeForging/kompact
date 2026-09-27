/**
 * Study 11 — how far is kompact's scorer from the offline optimum?
 *
 * kompact's keep/drop is an eviction policy. With the reuse labels we know the
 * future, so we can compute the best-possible decision (Belady-style: keep an
 * output iff it is actually needed later) and measure the shipped logistic's gap
 * to it. This says whether the scorer is near its ceiling or leaving headroom a
 * better scorer could take.
 *
 * The stringent, honest metric is freed@100%-needed-retention: the share of output
 * characters a policy can drop while never dropping a needed output. The oracle
 * drops every not-needed output (its freed@100 = all not-needed chars). A real
 * scorer can only drop outputs ranked below the LOWEST-scored needed output, so
 * its freed@100 is smaller — the gap is pure ranking headroom. Also reported at a
 * practical 95% retention, and against a size-only baseline.
 *
 * Reproducible: reads the committed corpus fixture; fits the shipped logistic
 * out-of-fold by session. No model, no network.
 *
 * Run: bun eval/offline-optimal.ts [--write] [--self-check]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { droppableAt } from './metrics.js';
import { FEATURE_NAMES, featureVector } from '../src/features.js';
import { outOfFold } from './logistic.js';
import { loadCorpus, rowKey } from './corpus.js';
import { MUTATING, UNREPEATABLE } from '../src/state.js';

const dir = import.meta.dirname;
const args = process.argv.slice(2);

/** Freed share at a retention floor, for a keep-probability ranking. */
function freedAt(scores: number[], needed: boolean[], chars: number[], safety: number): number {
  const total = chars.reduce((a, b) => a + b, 0) || 1;
  return droppableAt(scores, needed, chars, safety).droppedChars / total;
}

function main() {
  const { rows, from } = loadCorpus(dir, { paired: true });
  if (rows.length === 0) { console.log('no corpus'); return; }
  const needed = rows.map((r) => r.result_needed);
  const chars = rows.map((r) => r.output_chars);
  const total = chars.reduce((a, b) => a + b, 0) || 1;

  // The offline optimum: drop exactly the not-needed outputs.
  const oracleFreed = chars.reduce((s, c, i) => s + (needed[i] ? 0 : c), 0) / total;

  // Shipped logistic, out-of-fold by session (same recipe as eval/repeat.ts).
  const X = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
  const y = needed.map((b) => (b ? 1 : 0));
  const logistic = outOfFold(rows.map((r) => ({ session: r.session })), X, y);
  // kompact's REAL policy never lets the scorer drop a mutating or unrepeatable
  // output, whatever it scores; those are exactly the low-scored-but-needed outliers.
  const forced = rows.map((r) => MUTATING.has(r.tool) || UNREPEATABLE.has(r.tool));
  const policy = logistic.map((v, i) => (forced[i] ? Infinity : v));
  // Size-only baseline: a bigger output is likelier droppable (keep-prob ~ -chars).
  const size = chars.map((c) => -c);

  const fixture = {
    calls: rows.length,
    neededPct: Number((100 * needed.filter(Boolean).length / rows.length).toFixed(1)),
    oracleFreedPct: Number((100 * oracleFreed).toFixed(1)),
    logisticRawFreedAt100Pct: Number((100 * freedAt(logistic, needed, chars, 1.0)).toFixed(1)),
    policyFreedAt100Pct: Number((100 * freedAt(policy, needed, chars, 1.0)).toFixed(1)),
    policyFreedAt95Pct: Number((100 * freedAt(policy, needed, chars, 0.95)).toFixed(1)),
    forceKeptPct: Number((100 * forced.filter(Boolean).length / rows.length).toFixed(1)),
    sizeFreedAt100Pct: Number((100 * freedAt(size, needed, chars, 1.0)).toFixed(1)),
    featureCount: FEATURE_NAMES.length,
    corpus: from,
  };
  const gap100 = Number((fixture.oracleFreedPct - fixture.policyFreedAt100Pct).toFixed(1));

  console.log(`\ncorpus: ${fixture.calls} calls (${from}), ${fixture.neededPct}% needed later`);
  console.log(`\nfreed @ 100% needed-retention (drop nothing needed):`);
  console.log(`  offline optimum (oracle):       ${fixture.oracleFreedPct}%   <- ceiling`);
  console.log(`  kompact policy (force-keeps on): ${fixture.policyFreedAt100Pct}%   (gap to optimum: ${gap100} pts)`);
  console.log(`  raw logistic ranking (no keeps): ${fixture.logisticRawFreedAt100Pct}%`);
  console.log(`  size-only baseline:             ${fixture.sizeFreedAt100Pct}%`);
  console.log(`  (${fixture.forceKeptPct}% of calls are force-kept: mutating/unrepeatable)`);
  console.log(`\nfreed @ 95% retention: kompact policy ${fixture.policyFreedAt95Pct}%`);
  const nearCeiling = gap100 <= 10;
  console.log(`\nverdict: ${nearCeiling
    ? `NEAR-CEILING at 100% retention: the logistic leaves only ${gap100} pts of freeing on the table vs a perfect-foresight oracle, so a better SCORER buys little — headroom is elsewhere (the drop policy / archive), not the ranking.`
    : `HEADROOM: the logistic frees ${gap100} pts less than the oracle at 100% retention — needed outputs are scored too low, so a better scorer (features or method) could safely free more. Worth pursuing before shipping a heavier method.`}`);
  console.log(`(At 100% retention a scorer can only drop outputs ranked below the lowest-scored needed output, so this is a stringent ceiling; the 95% figure is the practical one.)`);

  if (args.includes('--write')) {
    writeFileSync(join(dir, 'fixtures', 'offline-optimal.json'), JSON.stringify(fixture, null, 2) + '\n');
    console.log(`\nwrote fixtures/offline-optimal.json`);
  }
}

/** ponytail: self-check freedAt + oracle on a hand-built set. */
function selfCheck() {
  // 4 outputs, 100 chars each; 2 needed. A PERFECT ranking (needed high) frees the
  // 2 not-needed = 50% at 100% retention, matching the oracle.
  const needed = [true, true, false, false];
  const chars = [100, 100, 100, 100];
  const perfect = [0.9, 0.8, 0.1, 0.2];
  if (Math.abs(freedAt(perfect, needed, chars, 1.0) - 0.5) > 1e-9) throw new Error('perfect scorer should free 50% at 100% retention');
  // An INVERTED ranking (needed scored low) can drop nothing without losing needed.
  const inverted = [0.1, 0.2, 0.9, 0.8];
  if (freedAt(inverted, needed, chars, 1.0) !== 0) throw new Error('inverted scorer should free 0% at 100% retention');
  const oracle = chars.reduce((s, c, i) => s + (needed[i] ? 0 : c), 0) / chars.reduce((a, b) => a + b, 0);
  if (Math.abs(oracle - 0.5) > 1e-9) throw new Error('oracle should be 50%');
}

selfCheck();
if (args.includes('--self-check')) console.log('self-check ok');
else main();
