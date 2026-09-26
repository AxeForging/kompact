/**
 * What the summary kompact replaces costs to produce, from real compactions.
 *
 * Claude Code writes a `compact_boundary` event on every compaction with its own
 * `compactMetadata.durationMs` — how long its summariser took. Nothing here had
 * ever read it. Across this machine's transcripts it is a stark number: the
 * built-in summary takes a median of a couple of minutes, against kompact's pass
 * measured in milliseconds (the scoring cost in the section above).
 *
 * This publishes the *produce* time only, and says so. What the assistant loses
 * by not getting the narrative summary is a different question and stays on the
 * ledger as not verified — conflating the two is the overstatement this project
 * exists to avoid.
 *
 * Machine-local like `eval/passes.ts`; the fixture is a scrubbed aggregate (counts
 * and durations, no transcript content), rendered from the committed copy so
 * `npm run docs` regenerates the figure anywhere.
 *
 * Run: bun eval/summary-cost.ts [--measure]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = import.meta.dirname;
const fixturePath = join(dir, 'fixtures', 'summary-cost.json');

/** Above this many ms a compaction is the built-in summariser, not kompact. */
const BUILTIN_MS = 60_000;
/**
 * Below this many ms a compaction is mechanical — kompact. A model summary, auto
 * or from a manual `/compact`, cannot finish this fast; anything in between is a
 * fast model summary and belongs to neither bucket.
 */
const KOMPACT_MS = 2_000;

type Fixture = {
  count: number; medianSec: number; minSec: number; maxSec: number; medianReductionPct: number;
  /** Median tokens the built-in summary leaves alive. */
  builtinMedianKept: number;
  /** kompact's own passes on this machine: sub-60s compactions that cut the window. */
  kompactCount: number; kompactMedianMs: number; kompactMedianKept: number;
};

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    try {
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (entry.endsWith('.jsonl')) out.push(path);
    } catch { /* a session being written can vanish mid-walk */ }
  }
  return out;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

if (process.argv.includes('--measure')) {
  const ms: number[] = [];
  const reductions: number[] = [];
  const builtinKept: number[] = [];
  // kompact's own passes: a compaction that finished in under a minute and still
  // reduced the window. The 60s split that names the built-in also names these.
  const kompactMs: number[] = [];
  const kompactKept: number[] = [];
  for (const path of walk(join(homedir(), '.claude', 'projects'))) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes('compact_boundary')) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.subtype !== 'compact_boundary') continue;
      const m = row.compactMetadata ?? {};
      if (typeof m.durationMs !== 'number') continue;
      const reduced = m.preTokens > 0 && typeof m.postTokens === 'number' && m.postTokens < m.preTokens;
      if (m.durationMs >= BUILTIN_MS) {
        ms.push(m.durationMs);
        if (reduced) {
          reductions.push((100 * (m.preTokens - m.postTokens)) / m.preTokens);
          builtinKept.push(m.postTokens);
        }
      } else if (reduced && m.durationMs < KOMPACT_MS) {
        kompactMs.push(m.durationMs);
        kompactKept.push(m.postTokens);
      }
    }
  }
  if (ms.length === 0) throw new Error('no built-in compactions found to measure');
  const fixture: Fixture = {
    count: ms.length,
    medianSec: Math.round(median(ms) / 1000),
    minSec: Math.round(Math.min(...ms) / 1000),
    maxSec: Math.round(Math.max(...ms) / 1000),
    medianReductionPct: Math.round(median(reductions)),
    builtinMedianKept: Math.round(median(builtinKept)),
    kompactCount: kompactMs.length,
    kompactMedianMs: kompactMs.length ? Math.round(median(kompactMs)) : 0,
    kompactMedianKept: kompactKept.length ? Math.round(median(kompactKept)) : 0,
  };
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${fixturePath}:`, fixture);
}

const f = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

const kfmt = (n: number): string => `${Math.round(n / 1000)}k`;
const keptClause = f.kompactCount > 0
  ? `\n  <p class="fine">
    And what each keeps alive. The built-in summary cut the window to a median
    <b>${kfmt(f.builtinMedianKept)}</b> tokens; kompact&#8217;s own passes here
    (<b>${f.kompactCount}</b>, median <b>${f.kompactMedianMs}&#8239;ms</b>) left
    <b>${kfmt(f.kompactMedianKept)}</b> &#8212; it fires earlier and compresses less, so more
    of the transcript stays verbatim. It does not compact <em>less often</em>; each pass is
    milliseconds, and the slow summary is left only for the residue kompact cannot drop.</p>`
  : '';

const markup = `  <p class="fine">
    What it replaces, timed. Over <b>${f.count}</b> real auto&#8209;compactions on this machine,
    Claude Code&#8217;s own summariser took a median <b>${f.medianSec}&#8239;s</b> to produce
    (${f.minSec}&#8239;s to ${f.maxSec}&#8239;s), each cutting the transcript by about
    ${f.medianReductionPct}%. kompact answers the same compaction with a pass measured in
    milliseconds. This is the summary&#8217;s cost to <em>produce</em>, read from Claude Code&#8217;s
    own <code>durationMs</code> &#8212; which times the whole compaction request, not only the pause
    on screen, on one machine. What the assistant loses by not getting that narrative is a different
    question and <a href="#checked">stays not verified</a>.</p>${keptClause}`;

const page = join(dir, '..', 'docs', 'evidence.html');
const html = readFileSync(page, 'utf8');
const open = '  <!-- summarycost:render -->\n';
const close = '\n  <!-- /summarycost:render -->';
const from = html.indexOf(open);
const to = html.indexOf(close);
if (from < 0 || to < 0) throw new Error(`no summarycost:render markers in ${page}`);
writeFileSync(page, html.slice(0, from + open.length) + markup + html.slice(to));
console.log(`spliced summary-cost (${f.count} compactions, median ${f.medianSec}s) into docs/evidence.html`);
