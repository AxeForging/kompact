/**
 * The (trigger, floor) study, measured and rendered.
 *
 * Two numbers decide the whole loop — `compactAtPercent` and `minFreedPercent`
 * — and neither had been swept. This runs the grid on this machine's own
 * transcripts through `eval/passes.ts --json`, measures the headroom the
 * trigger needs, writes the fixture, and splices both figures into
 * `docs/trigger.html`.
 *
 * The one input here that is *not* measured is the engine's own threshold.
 * Claude Code auto-compacts at 70% of the window by default; that is the
 * documented behaviour and nothing in this repository verifies it. It is the
 * ceiling the whole recommendation rests on, so it is labelled on the page as
 * an input rather than a finding.
 *
 * Machine-local like `eval/passes.ts`, and rendered from the committed fixture
 * so `npm run docs` regenerates the page anywhere.
 *
 * Run: bun eval/trigger-page.ts [--measure]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { messageChars, tokensIn } from '../src/compact.js';
import { HOOK_DEFAULTS } from '../hooks/kompact.js';
import { readTranscript } from './transcript.js';

const dir = import.meta.dirname;
const fixturePath = join(dir, 'fixtures', 'trigger.json');

/** Claude Code's documented auto-compaction threshold. Not measured here. */
const ENGINE_AT = 70;
const TRIGGERS = [50, 55, 58, 60, 62, 64, 66, 68, 69];
const FLOORS = [3, 4, 5, 7, 10, 15];
const WINDOW = 200_000;
const SESSIONS = 5;

type Cell = { at: number; floor: number; taken: number; looped: number; freedPp: number };
type Fixture = {
  engineAt: number; window: number; sessions: number;
  chosen: { at: number; floor: number };
  grid: Cell[];
  headroom: {
    messages: number; median: number; p90: number; p99: number; max: number;
    over5: number; overGap: number;
  };
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

/**
 * What one turn costs the window, over every message of the largest sessions.
 *
 * This is the number that picks the trigger. The gap between kompact's trigger
 * and the engine's has to be wider than one more turn, or the engine reaches
 * its own threshold first and kompact never answers.
 */
function headroom(gap: number): Fixture['headroom'] {
  const paths = walk(join(homedir(), '.claude', 'projects'))
    .map((path) => ({ path, size: statSync(path).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, SESSIONS);
  const points: number[] = [];
  for (const { path } of paths) {
    for (const message of readTranscript(path)) {
      points.push((100 * tokensIn(messageChars(message))) / WINDOW);
    }
  }
  points.sort((a, b) => a - b);
  const at = (fraction: number): number =>
    Number((points[Math.floor(fraction * (points.length - 1))] ?? 0).toFixed(2));
  return {
    messages: points.length,
    median: at(0.5), p90: at(0.9), p99: at(0.99),
    max: Number((points.at(-1) ?? 0).toFixed(2)),
    over5: points.filter((p) => p > 5).length,
    overGap: points.filter((p) => p > gap).length,
  };
}

if (process.argv.includes('--measure')) {
  const grid: Cell[] = [];
  for (const at of TRIGGERS) {
    for (const floor of FLOORS) {
      const out = execFileSync('bun', [
        join(dir, 'passes.ts'), '--at', String(at), '--floor', String(floor), '--json',
      ], { encoding: 'utf8', cwd: join(dir, '..') });
      const row = JSON.parse(out.trim().split('\n').at(-1)!) as Cell;
      grid.push({ at, floor, taken: row.taken, looped: row.looped, freedPp: row.freedPp });
      process.stderr.write(`  ${at}% / ${floor}pp -> ${row.taken} deferred\n`);
    }
  }
  const fixture: Fixture = {
    engineAt: ENGINE_AT, window: WINDOW, sessions: SESSIONS,
    chosen: { at: HOOK_DEFAULTS.compactAtPercent, floor: HOOK_DEFAULTS.minFreedPercent },
    grid, headroom: headroom(ENGINE_AT - HOOK_DEFAULTS.compactAtPercent),
  };
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${fixturePath}: ${grid.length} cells`);
}

const f = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const floors = [...new Set(f.grid.map((c) => c.floor))].sort((a, b) => a - b);
const triggers = [...new Set(f.grid.map((c) => c.at))].sort((a, b) => a - b);
const best = Math.max(...f.grid.map((c) => c.taken));

/**
 * The grid, as a table that shades itself.
 *
 * A cell's class carries three facts a reader needs at a glance: whether the
 * loop runs at all (`--dead`), whether it is at the best count found
 * (`--best`), and which cell ships. The shade is computed here so the markup
 * is correct with no CSS doing arithmetic and no script needed to draw it.
 */
const cellFor = (at: number, floor: number): string => {
  const cell = f.grid.find((c) => c.at === at && c.floor === floor);
  if (!cell) return '<td class="grid__cell"></td>';
  const ships = at === f.chosen.at && floor === f.chosen.floor;
  const marks = [
    cell.taken === 0 ? 'grid__cell--dead' : '',
    cell.taken === best ? 'grid__cell--best' : '',
    ships ? 'grid__cell--ships' : '',
  ].filter(Boolean).join(' ');
  const shade = best === 0 ? 0 : Number((cell.taken / best).toFixed(2));
  return `<td class="grid__cell ${marks}" style="--v:${shade}">`
    + `<b>${cell.taken}</b>${ships ? '<span class="grid__ships">ships</span>' : ''}</td>`;
};

const deadFloors = floors.filter((floor) =>
  f.grid.filter((c) => c.floor === floor).every((c) => c.taken === 0));

const grid = `  <figure class="grid" id="grid">
    <div class="scroller" tabindex="0" data-label="Table: engine summaries deferred by trigger and floor">
      <table class="data grid__table">
        <caption class="visually-hidden">Engine summaries deferred, by trigger and floor</caption>
        <thead><tr><th scope="col">trigger</th>${
          floors.map((floor) => `<th scope="col" class="n">${floor}pp</th>`).join('')}</tr></thead>
        <tbody>
${triggers.map((at) => `          <tr><th scope="row">${at}%</th>${
  floors.map((floor) => cellFor(at, floor)).join('')}</tr>`).join('\n')}
        </tbody>
      </table>
    </div>
    <figcaption class="caption">Engine summaries deferred over ${f.sessions} real sessions on one
      machine, at every trigger below the engine&#8217;s own and every floor worth trying. Darker is
      more deferred. A <b>0</b> is a setting where the loop never takes a pass at all: the plugin is
      installed, it logs, and it answers nothing.${deadFloors.length > 0
    ? ` Every trigger at ${deadFloors.join('pp and ')}pp is that, which is why the floor did not go up; whether it should go down is the open question below.`
    : ''} <code>bun eval/trigger-page.ts --measure</code> re-runs it on yours.</figcaption>
  </figure>`;

const h = f.headroom;
const gap = f.engineAt - f.chosen.at;
/**
 * The rail is zoomed, and says so.
 *
 * Drawn 0-100% of the window, the whole argument lives in the eight points
 * between the two thresholds and 92% of the figure is empty — and the two
 * labels land on top of each other. It spans a window either side of the gap
 * instead, with both ends named so the zoom is on the face of it.
 */
const FROM = Math.max(0, f.chosen.at - 7);
const TO = Math.min(100, f.engineAt + 5);
const place = (at: number): string =>
  `${((100 * (at - FROM)) / (TO - FROM)).toFixed(2)}%`;
const headroomFigure = `  <figure class="gap" id="headroom">
    <p class="gap__lead">The trigger has to leave room for one more turn to land</p>
    <div class="gap__rail" aria-hidden="true">
      <span class="gap__band" style="--from:${place(f.chosen.at)};--to:${place(f.engineAt)}"></span>
      <span class="gap__turn" style="--from:${place(f.chosen.at)};--w:${
        ((100 * h.max) / (TO - FROM)).toFixed(2)}%"><b>${h.max}pp &#183; the worst turn measured</b></span>
      <span class="gap__mark gap__mark--ours" style="--x:${place(f.chosen.at)}">
        <b>kompact ${f.chosen.at}%</b></span>
      <span class="gap__mark gap__mark--engine" style="--x:${place(f.engineAt)}">
        <b>engine ${f.engineAt}%</b></span>
      <span class="gap__end gap__end--from">${FROM}%</span>
      <span class="gap__end gap__end--to">${TO}% of the window</span>
    </div>
    <p class="gap__sum"><span><b>${gap} points</b> of headroom</span><span><b>${
      h.max}pp</b> the largest single message</span><span><b>${h.overGap}</b> of ${
      h.messages.toLocaleString()} messages would overrun it</span></p>
    <figcaption class="caption">Every message of the ${f.sessions} largest sessions on one machine,
      priced as points of a ${f.window / 1000}k&#8209;token window: median ${h.median}, 90th
      percentile ${h.p90}, 99th ${h.p99}, largest <b>${h.max}</b>. Only ${h.over5} of
      ${h.messages.toLocaleString()} cost more than 5 points, so a trigger at ${f.chosen.at}% has
      room for the worst turn in the corpus to land before the engine reaches ${f.engineAt}%.
      <b>The engine&#8217;s ${f.engineAt}% is Claude Code&#8217;s documented default, not something
      measured here</b>: it is the assumption the whole setting rests on, and it is on
      <a href="evidence.html#checked">the ledger</a> as one.</figcaption>
  </figure>`;

/**
 * The floor's own curve, at the trigger that ships.
 *
 * The grid ranks cells by summaries deferred and the best column in it is the
 * lowest floor, not the one that ships. That is not a detail to leave to a
 * reader's arithmetic: this draws what each floor reclaims and defers, so the
 * gap between what is measured and what is chosen is on the page rather than
 * implied by it.
 */
const atChosen = f.grid.filter((c) => c.at === f.chosen.at).sort((a, b) => a.floor - b.floor);
const topPp = Math.max(...atChosen.map((c) => c.freedPp));
const floorCurve = `  <figure class="curve" id="floorcurve">
    <p class="curve__lead">At the trigger that ships, what each floor reclaims</p>
    <ol class="curve__list">
${atChosen.map((cell, index) => {
  const ships = cell.floor === f.chosen.floor;
  const share = topPp === 0 ? 0 : (cell.freedPp / topPp).toFixed(4);
  return `      <li class="curve__row${ships ? ' curve__row--ships' : ''}${
    cell.taken === 0 ? ' curve__row--dead' : ''}" style="--i:${index}">`
    + `<span class="curve__who">${cell.floor}pp${ships ? '<span> ships</span>' : ''}</span>`
    + `<span class="curve__track"><span class="curve__fill" style="--w:${share}"></span></span>`
    + `<span class="curve__pp">${cell.freedPp.toFixed(1)}</span>`
    + `<span class="curve__n">${cell.taken} deferred</span></li>`;
}).join('\n')}
    </ol>
    <figcaption class="caption">Points of a ${f.window / 1000}k&#8209;token window reclaimed across
      ${f.sessions} sessions, and the engine summaries each floor deferred, at a ${f.chosen.at}%
      trigger. <b>The lowest floor measured reclaims the most and defers the most</b>, and the share
      of surviving results that is a truncation note is the same at ${atChosen[0]?.floor}pp as at
      ${f.chosen.floor}pp. What ${f.chosen.floor}pp buys is a wider band a session has to grow back
      through before it can be compacted again &#8212; a judgement about how often to interrupt a
      session rather than a measurement. It is the open question on this page.</figcaption>
  </figure>`;

const pagePath = join(dir, '..', 'docs', 'trigger.html');
let page = readFileSync(pagePath, 'utf8');
for (const [name, body] of [['grid', grid], ['headroom', headroomFigure],
  ['floorcurve', floorCurve]] as const) {
  const open = `  <!-- ${name}:render -->\n`;
  const close = `\n  <!-- /${name}:render -->`;
  const from = page.indexOf(open);
  const to = page.indexOf(close);
  if (from < 0 || to < 0) throw new Error(`no ${name}:render markers in ${pagePath}`);
  page = page.slice(0, from + open.length) + body + page.slice(to);
}
writeFileSync(pagePath, page);
console.log(`spliced the grid (${f.grid.length} cells), the headroom figure and the floor `
  + `curve into docs/trigger.html`);
