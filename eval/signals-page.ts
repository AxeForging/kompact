/**
 * Renders the committed signals fixture into `docs/index.html`.
 *
 * Same contract as `eval/demo.ts`: read a generated fixture, splice markup
 * between markers, and never let a number be typed into the page by hand. The
 * fixture comes from `eval/signals-fixture.ts --publish`, which keeps only the
 * shapes that repeated and strips every sample before anything is committed.
 *
 * What this renders is deliberately unflattering. The headline is that 25 of
 * 2,000 shapes repeated, and the top rows are generic shell verbs rather than
 * workflows anyone would write a skill for. That is the finding, and this page
 * gives negative findings the same weight as positive ones.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { estimateSaved } from '../src/signals.js';
import { type Proposal, draft, slugFor } from './propose.js';

type Row = {
  kind: string;
  n: number;
  calls: number;
  chars: number;
  sessions: string[];
  samples: string[];
  lastSeen: number;
};

const dir = import.meta.dirname;
const fixture = JSON.parse(
  readFileSync(join(dir, 'fixtures', 'signals.json'), 'utf8'),
) as {
  meta: { sessions: number; calls: number; shapes: number; repeated: number; commands: number };
  rows: Record<string, Row>;
  order: number[];
};

const LABELS: Record<string, string> = {
  command: 'the same command',
  sequence: 'the same run of tools',
  intent: 'the same request',
  'error-fix': 'got working on a retry',
  correction: 'had to correct the assistant',
  orient: 'how a session starts',
  verify: 'checked before handing back',
};

/** Whether a row names work anyone would write a skill about. Judged, and marked. */
const GENERIC = /^(?:sed|cat|grep|python3|ls|head|tail|wc|echo|find)\b/;

const ranked = Object.entries(fixture.rows)
  .map(([key, row]) => ({
    ...row,
    sig: key.slice(key.indexOf('::') + 2),
    saved: estimateSaved(row.n, row.calls / row.n, row.chars / row.n),
  }))
  .sort((a, b) => b.saved - a.saved);

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const rows = ranked.slice(0, 10).map((row) => {
  const isGeneric = row.kind === 'command' && GENERIC.test(row.sig);
  return `      <tr${isGeneric ? ' class="dim"' : ''}>` +
    `<td>${escape(LABELS[row.kind] ?? row.kind)}</td>` +
    `<td><code>${escape(row.sig)}</code></td>` +
    `<td class="n">${row.n}</td>` +
    `<td class="n">${row.sessions.length}</td>` +
    `<td class="n">${row.calls}</td>` +
    `<td class="n">${row.chars === 0 ? '&#8212;' : row.chars.toLocaleString()}</td>` +
    `<td class="n">${row.saved.toFixed(1)}</td></tr>`;
}).join('\n');

const commandRows = ranked.filter((row) => row.kind === 'command');
const genericRows = commandRows.filter((row) => GENERIC.test(row.sig));
/** The command shapes `GENERIC` does not name, so the page can name them itself. */
const rest = commandRows.filter((row) => !GENERIC.test(row.sig));
const generic = genericRows.length;
const commands = commandRows.length;
const top = ranked[0];
if (!top) throw new Error('the fixture has no rows');
// A workflow row is one this ranking should have wanted and did not: a sequence
// of different tools. Naming the best one, and where it landed, is the finding.
const workflow = ranked.find((row) => row.kind === 'sequence' && /Bash\(/.test(row.sig));
const workflowPlace = workflow ? ranked.indexOf(workflow) + 1 : 0;

const markup = `  <p class="caption caption--fig">${fixture.meta.repeated} shapes that repeated, of ` +
  `${fixture.meta.shapes.toLocaleString()} recorded over ${fixture.meta.sessions} sessions ` +
  `and ${fixture.meta.calls.toLocaleString()} tool calls</p>
      <details class="more">
    <summary><h3>All ${fixture.meta.repeated} shapes that repeated, ranked</h3></summary>
<div class="scroller" data-label="Table: what repeated">
  <table class="data">
    <thead><tr><th>Kind</th><th>Signature</th><th class="n">times</th>` +
  `<th class="n">sessions</th><th class="n">calls</th><th class="n">chars</th>` +
  `<th class="n">est.</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>
  <p class="caption">est. = total tool calls + total output characters / 1000, the ranking
    chosen for this. A model of effort, not a measurement of time; every input to it is on the row,
    so any row can be recomputed by hand. Greyed rows are generic shell verbs.</p>

    </details>

  <div class="finding finding--loss reveal">
    <p>Of <span class="val">${fixture.meta.shapes.toLocaleString()}</span> shapes recorded,
      <span class="val">${fixture.meta.repeated}</span> repeated enough to propose — and
      ${generic === commands
        ? `all <span class="val">${generic}</span>`
        : `<span class="val">${generic}</span> of the ${commands}`} repeated command shapes are generic
      shell verbs. The highest-ranked thing this found is
      <code>${escape(top.sig)}</code>.</p>
  </div>
  <p>
    ${generic === commands
      ? 'Every one of them is a verb like'
      : `${generic} of the ${commands} are verbs like`}
    <code>sed</code>, <code>grep</code> or <code>cat</code>. No skill helps with those.${generic === commands
      ? ''
      : ` The ${commands - generic} that fall outside that list &#8212;
      ${rest.map((row) => `<code>${escape(row.sig)}</code>`).join(' and ')} &#8212; are not
      workflows either; they are simply verbs the list was not written to catch, and adding them
      to it to keep a sentence tidy is the kind of tuning this page exists to avoid.`}${workflow
      ? ` The best row that reads like an actual workflow &#8212;
      <code>${escape(workflow.sig)}</code> &#8212; is ranked ${workflowPlace}th, because the ranking
      rewards total work and a generic verb runs more often than a workflow does.`
      : ''}
  </p>`;

// The stream the page replays: which shape each command landed on, in the order
// the calls arrived. Indices only — the signatures travel in the markup, and the
// samples were stripped before any of this was committed.
const keys = Object.keys(fixture.rows);
const shown = ranked
  .filter((row) => row.kind === 'command')
  .slice(0, 6)
  .map((row) => ({ sig: row.sig, n: row.n, key: `command::${row.sig}` }));
const seat = new Map(shown.map((row, index) => [row.key, index]));
/**
 * Three states, not two.
 *
 * Collapsing everything outside the six shown bars into `-1` made the page count
 * the 13 commands that landed on the other four *repeated* shapes as commands
 * nothing else shares, and print 1,638 where the fixture says 1,625. The counter
 * is labelled "on a shape nothing else shares", so that was simply wrong — on a
 * page whose rule is that no modelled number is presented as measured, by the
 * one number the animation exists to show.
 */
const stream = fixture.order.map((index) => {
  const key = keys[index];
  if (key === undefined) return -1; // landed on nothing that repeated
  return seat.has(key) ? (seat.get(key) as number) : -2; // repeated, just not shown
});
writeFileSync(join(dir, '..', 'docs', 'signals-data.js'),
  `/* Generated by eval/signals-page.ts — do not edit. */\nwindow.SIGNALS = ${JSON.stringify({
    rows: shown.map((row) => ({ sig: row.sig, n: row.n })),
    stream,
    commands: fixture.meta.commands,
    // The actual draft `npm run propose -- --write 1` produces for the top row,
    // rendered by the same function the CLI calls. The page shows the product's
    // own output rather than a mock-up of it.
    draft: draft({
      ...(fixture.rows[`command::${ranked[0]?.sig}`] as Row),
      sig: ranked[0]?.sig ?? '',
      saved: ranked[0]?.saved ?? 0,
    } as Proposal),
    // Which row the draft came from, and where `--write 1` puts it. The bars and
    // the file sat next to each other saying nothing about each other; a reader
    // could watch the whole run and not see that one becomes the other.
    top: ranked[0]?.sig ?? '',
    path: `.kompact/proposals/${slugFor('command', ranked[0]?.sig ?? '')}/SKILL.md`,
    shapes: fixture.meta.shapes,
    repeated: fixture.meta.repeated,
  })};\n`);
console.log(`wrote docs/signals-data.js: ${stream.length} arrivals, ` +
  `${stream.filter((x) => x >= 0).length} onto the ${shown.length} shapes shown`);

const page = join(dir, '..', 'docs', 'index.html');
const html = readFileSync(page, 'utf8');
const open = '  <!-- signals:render -->\n';
const close = '\n  <!-- /signals:render -->';
const from = html.indexOf(open);
const to = html.indexOf(close);
if (from < 0 || to < 0) throw new Error(`no signals:render markers in ${page}`);
writeFileSync(page, html.slice(0, from + open.length) + markup + html.slice(to));

console.log(`Run: ${fixture.meta.sessions} sessions, ${fixture.meta.calls.toLocaleString()} calls`);
console.log(`${fixture.meta.repeated} of ${fixture.meta.shapes.toLocaleString()} shapes repeated; ` +
  `${generic} of ${commands} repeated command shapes are generic shell verbs.`);
console.log(`wrote ${rows.split('\n').length} rows into docs/index.html`);
