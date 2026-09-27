/**
 * Study 14 — does imitating the Belady oracle's TARGET help?
 *
 * The imitation-learning-for-cache-replacement line (Liu et al., ICML 2020) and
 * reuse-prediction (Faldu, 2020) train on the future reuse pattern, not a bare
 * needed/not-needed bit. kompact trains on binary `result_needed` (reused at all,
 * ever). This asks whether a near-term target — "reused within N messages" — gives
 * a scorer that frees more at the SAME true needed-retention, since a soon-reused
 * output is the one that actually matters to keep and a far/never one is safe to drop.
 *
 * Every variant is trained out-of-fold, then scored on the metric that decides:
 * freed characters at a floor on the TRUE `result_needed` retention (not the
 * training target). Reproducible: committed fixture, no model. Run: bun eval/reuse-target.ts [--write]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { droppableAt } from './metrics.js';
import { featureVector } from '../src/features.js';
import { outOfFold } from './logistic.js';
import { loadCorpus } from './corpus.js';

function main() {
  const args = process.argv.slice(2);
  const { rows, from } = loadCorpus(import.meta.dirname, { fixtureOnly: args.includes('--fixture') });
  const trueNeeded = rows.map((r) => r.result_needed);
  const chars = rows.map((r) => r.output_chars);
  const total = chars.reduce((a, b) => a + b, 0) || 1;
  const X = rows.map((r) => featureVector(r.state, r.tool, r.is_error));
  const dist = rows.map((r) => (r.result_needed ? (r.first_reuse_index - r.result_index) : Infinity));
  const freedAt = (p: number[], safety: number) =>
    Number((100 * droppableAt(p, trueNeeded, chars, safety).droppedChars / total).toFixed(1));

  const targets: [string, (i: number) => boolean][] = [
    ['any reuse (shipped)', (i) => trueNeeded[i]!],
    ['reused <= 10 msgs', (i) => trueNeeded[i]! && dist[i]! <= 10],
    ['reused <= 25 msgs', (i) => trueNeeded[i]! && dist[i]! <= 25],
    ['reused <= 50 msgs', (i) => trueNeeded[i]! && dist[i]! <= 50],
  ];
  console.log(`corpus (${from}): ${rows.length} calls, ${new Set(rows.map((r) => r.session)).size} sessions`);
  console.log('trained-on target        freed@90%  freed@85%  (retention = TRUE result_needed)');
  const out: { target: string; f90: number; f85: number }[] = [];
  let base85 = 0;
  for (const [name, t] of targets) {
    const y = rows.map((_, i) => (t(i) ? 1 : 0));
    const p = outOfFold(rows.map((r) => ({ session: r.session })), X, y);
    const f90 = freedAt(p, 0.9), f85 = freedAt(p, 0.85);
    if (name.startsWith('any')) base85 = f85;
    out.push({ target: name, f90, f85 });
    console.log(name.padEnd(24), `${f90.toFixed(1).padStart(8)}%  ${f85.toFixed(1).padStart(8)}%`);
  }
  const best = out.slice(1).reduce((m, r) => (r.f85 > m.f85 ? r : m), out[1]!);
  const verdict = best.f85 - base85 > 2
    ? `HELPS: training on "${best.target}" frees +${(best.f85 - base85).toFixed(1)} pts at 85% vs the binary target.`
    : `NO GAIN: no near-term target beats binary result_needed by >2 pts at 85% retention — for one-shot compaction, "needed at all" already is the Belady target.`;
  console.log(`\nverdict: ${verdict}`);
  if (args.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'fixtures', 'reuse-target.json'),
      JSON.stringify({ calls: rows.length, targets: out, verdict }, null, 2) + '\n');
    console.log('wrote fixtures/reuse-target.json');
  }
  return { out, base85 };
}

if (import.meta.main) {
  const { out, base85 } = main();
  console.assert(out[0]!.f85 === base85 && base85 > 0, 'baseline target must reproduce a positive freed@85');
}
