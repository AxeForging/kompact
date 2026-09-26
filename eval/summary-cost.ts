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

type Fixture = {
  count: number; medianSec: number; minSec: number; maxSec: number; medianReductionPct: number;
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
  for (const path of walk(join(homedir(), '.claude', 'projects'))) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes('compact_boundary')) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.subtype !== 'compact_boundary') continue;
      const m = row.compactMetadata ?? {};
      if (typeof m.durationMs !== 'number' || m.durationMs < BUILTIN_MS) continue;
      ms.push(m.durationMs);
      if (m.preTokens > 0 && typeof m.postTokens === 'number') {
        reductions.push((100 * (m.preTokens - m.postTokens)) / m.preTokens);
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
  };
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${fixturePath}:`, fixture);
}

const f = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

const markup = `  <p class="fine">
    What it replaces, timed. Over <b>${f.count}</b> real auto&#8209;compactions on this machine,
    Claude Code&#8217;s own summariser took a median <b>${f.medianSec}&#8239;s</b> to produce
    (${f.minSec}&#8239;s to ${f.maxSec}&#8239;s), each cutting the transcript by about
    ${f.medianReductionPct}%. kompact answers the same compaction with a pass measured in
    milliseconds. This is the summary&#8217;s cost to <em>produce</em>, read from Claude Code&#8217;s
    own <code>durationMs</code> &#8212; which times the whole compaction request, not only the pause
    on screen, on one machine. What the assistant loses by not getting that narrative is a different
    question and <a href="#checked">stays not verified</a>.</p>`;

const page = join(dir, '..', 'docs', 'evidence.html');
const html = readFileSync(page, 'utf8');
const open = '  <!-- summarycost:render -->\n';
const close = '\n  <!-- /summarycost:render -->';
const from = html.indexOf(open);
const to = html.indexOf(close);
if (from < 0 || to < 0) throw new Error(`no summarycost:render markers in ${page}`);
writeFileSync(page, html.slice(0, from + open.length) + markup + html.slice(to));
console.log(`spliced summary-cost (${f.count} compactions, median ${f.medianSec}s) into docs/evidence.html`);
