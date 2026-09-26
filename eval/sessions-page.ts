/**
 * Draws what compaction freed on each session, instead of apologising for it.
 *
 * The page carried the measurement as a range and then wrote a sentence about
 * the range: "somewhere in 8.7% to 32.0%, the range four sessions covered,
 * which is not a distribution." Four bars say that without the disclaimer
 * needing to do the work, because a reader can see four bars and count them.
 *
 * It reads `eval/SNAPSHOT.md`, not a fixture of its own. A second emit of the
 * same measurement is a second thing to keep in step, and this one went out of
 * step immediately: a fresh run of `sessions.ts` reported 29.5% while the
 * snapshot the masthead quotes still said 29.3%, because the corpus grows while
 * you work. Parsing the table the page already quotes means the figure and the
 * prose cannot disagree, and `npm run eval:snapshot` moves both at once.
 *
 * Run: bun eval/sessions-page.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = { calls: number; before: number; after: number; freed: number };

const dir = import.meta.dirname;
const num = (n: number): string => n.toLocaleString('en-GB');
const plain = (text: string): number => Number(text.replace(/[,%]/g, ''));

/**
 * Parses the fixed-width table `eval/sessions.ts` prints, as captured into
 * `SNAPSHOT.md` by `eval/results.ts`. Fails loudly rather than drawing an empty
 * figure: a chart with no bars is the kind of thing that ships.
 */
const snapshot = readFileSync(join(dir, 'SNAPSHOT.md'), 'utf8');
const table = /## What it frees in practice[\s\S]*?```\n([\s\S]*?)```/.exec(snapshot)?.[1];
if (!table) throw new Error('eval/SNAPSHOT.md has no sessions table to draw');

const parse = (line: string): Row | undefined => {
  const m = /^\S+\s+(\d+)\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)%/.exec(line.trim());
  // `m && {...}` returns null, not undefined, and the filter below tests for
  // undefined — so every row survived it as a null and the sort exploded.
  if (!m) return undefined;
  return { calls: plain(m[1]!), before: plain(m[2]!), after: plain(m[3]!), freed: plain(m[4]!) };
};
const lines = table.split('\n');
const totalLine = lines.find((line) => line.startsWith('total'));
const rows = lines
  .filter((line) => !line.startsWith('total') && !line.startsWith('session') && !line.startsWith('-'))
  .map(parse)
  .filter((row): row is Row => row !== undefined)
  .sort((a, b) => a.freed - b.freed);
const total = totalLine ? parse(totalLine) : undefined;
if (rows.length === 0 || !total) throw new Error('eval/SNAPSHOT.md sessions table has no rows');

const f = {
  sessions: rows.length, calls: total.calls, freed: total.freed,
  low: rows[0]!.freed, high: rows[rows.length - 1]!.freed, rows,
};

/**
 * One bar per session, least freed first.
 *
 * `--keep` is what survived, as a fraction, so the settled bar is already the
 * compacted session and the animation only has to let go of the rest. `--i`
 * staggers them. The two numbers beside each bar are the ones the row is drawn
 * from, so nothing on the figure is unlabelled.
 */
const bar = (row: Row, index: number): string => {
  const keep = ((100 - row.freed) / 100).toFixed(4);
  return `      <li class="spread__row" style="--i:${index}">`
    + `<span class="spread__who">${num(row.calls)}<span> calls</span></span>`
    + `<span class="spread__track"><span class="spread__kept" style="--keep:${keep}"></span></span>`
    + `<span class="spread__pct">${row.freed.toFixed(1)}%</span>`
    + `<span class="spread__tok">${num(Math.round((row.before - row.after) / 1000))}k tokens</span>`
    + '</li>';
};

const markup = `  <figure class="spread" id="spread">
    <p class="spread__lead">What one compaction freed, on each of the
      <b>${f.sessions}</b> largest sessions on one machine</p>
    <ol class="spread__list">
${f.rows.map(bar).join('\n')}
    </ol>
    <p class="spread__sum"><span><b>${f.freed.toFixed(1)}%</b> freed across all
      ${num(f.calls)} calls</span><span><b>${f.low}%</b> to <b>${f.high}%</b> per session</span></p>
    <figcaption class="caption">The dark part of each bar is what the session still held after one
      pass; the empty part is what it handed back. Four sessions is a reading of four sessions and
      not a distribution: what moves it is how much of the session was tool output in the first
      place, and nothing here has measured how much of the spread is noise.
      <code>npm run dry-run</code> measures yours.</figcaption>
  </figure>`;

const page = join(dir, '..', 'docs', 'index.html');
const html = readFileSync(page, 'utf8');
const open = '  <!-- spread:render -->\n';
const close = '\n  <!-- /spread:render -->';
const from = html.indexOf(open);
const to = html.indexOf(close);
if (from < 0 || to < 0) throw new Error(`no spread:render markers in ${page}`);
writeFileSync(page, html.slice(0, from + open.length) + markup + html.slice(to));
console.log(`spliced ${f.rows.length} session bars into docs/index.html (${f.low}%–${f.high}%)`);
