/**
 * The page's one image, made of the corpus.
 *
 * Every labelled call placed by the score the shipped model gives it, split by
 * what actually happened to it: reused verbatim later, or not. A ranking is an
 * abstract claim; this is what one looks like. It shows the model working — the
 * reused marks lean right — and it shows the overlap, which is the part a chart
 * of a single AUC number hides.
 *
 * Writes `docs/distribution.svg`, the static plate every reader gets, and
 * `docs/distribution-data.js`, the same marks as numbers so the page can animate
 * the ordering being applied. Both come from this one pass, so the picture that
 * settles is the picture that ships.
 *
 * Run: bun eval/distribution.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCorpus } from './corpus.js';
import { KEEP_RESULT_WEIGHTS, featureVector, score } from '../src/features.js';

const here = dirname(fileURLToPath(import.meta.url));
const { rows } = loadCorpus(here);

const W = 1200;
const H = 420;
const PAD = { left: 56, right: 24, top: 44, bottom: 52 };
const plot = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };
const FLOOR = 0.2;

interface Mark { x: number; y: number; reused: boolean }
const marks: Mark[] = [];
/** Deterministic jitter: the same corpus must draw the same picture every time. */
let seed = 20260925;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
};

for (const row of rows) {
  const s = score(KEEP_RESULT_WEIGHTS, featureVector(row.state, row.tool, row.is_error));
  const lane = row.result_needed ? 0 : 1;
  // Two bands, each jittered within itself, so 2,239 marks stay countable.
  const top = PAD.top + lane * (plot.h / 2);
  marks.push({
    x: PAD.left + s * plot.w,
    y: top + 10 + rand() * (plot.h / 2 - 26),
    reused: row.result_needed,
  });
}

const reused = marks.filter((m) => m.reused).length;
const dots = (want: boolean, cls: string): string => marks
  .filter((m) => m.reused === want)
  .map((m) => `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${want ? 2.6 : 1.5}" class="${cls}"/>`)
  .join('');

const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => {
  const x = PAD.left + t * plot.w;
  return `<line x1="${x}" y1="${H - PAD.bottom}" x2="${x}" y2="${H - PAD.bottom + 6}" class="ax"/>` +
    `<text x="${x}" y="${H - PAD.bottom + 22}" class="tick" text-anchor="middle">${t.toFixed(1)}</text>`;
}).join('');

const floorX = PAD.left + FLOOR * plot.w;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img"
  aria-labelledby="dist-title dist-desc" preserveAspectRatio="xMidYMid meet">
<title id="dist-title">Every labelled tool call, placed by the score it is given</title>
<desc id="dist-desc">A strip plot of ${rows.length.toLocaleString('en-GB')} tool calls. The upper band holds the ${reused} whose
output was reused verbatim later; the lower band the ${(rows.length - reused).toLocaleString('en-GB')} that were not. Position
is the model's keep-probability, from 0 on the left to 1 on the right. The reused band leans right,
which is the model working, and the two bands overlap heavily below 0.2, which is why a floor rather
than a cut decides anything. A vertical rule marks the shipped floor at ${FLOOR}. The marks fall
into vertical columns because twelve of the model's inputs are yes-or-no, so it has only a few
dozen distinct scores to give.</desc>
<style>
  /* The flooded ground, so the plate is part of the field rather than a hole
     cut in it. Values match the page's --flood / --on-flood tokens. */
  .bg{ fill: #7f0c00; }
  .kept{ fill: #fcf9f7; fill-opacity: .95; }
  /* .38 composited to 1.87:1 on the flood — the half of the argument that
     proves the overlap was, in practice, invisible. .62 clears 3:1. */
  .not{ fill: #e1b1a1; fill-opacity: .62; }
  .ax, .floor{ stroke: #e1b1a1; stroke-width: 1; stroke-opacity: 1; }
  .floor{ stroke-dasharray: 3 4; stroke-opacity: 1; }
  .tick, .lab{ fill: #e1b1a1; font: 500 13px/1 Archivo, ui-sans-serif, sans-serif; }
  .lab{ font-size: 14px; fill: #fcf9f7; }
</style>
<rect width="${W}" height="${H}" class="bg"/>
<line x1="${floorX}" y1="${PAD.top - 12}" x2="${floorX}" y2="${H - PAD.bottom}" class="floor"/>
<text x="${floorX + 8}" y="${PAD.top - 18}" class="tick">floor ${FLOOR}</text>
<text x="${PAD.left}" y="${PAD.top - 18}" class="lab"><tspan class="kept-l"><tspan font-weight="700">${reused}</tspan> reused verbatim later</tspan></text>
<text x="${PAD.left}" y="${PAD.top + plot.h / 2 - 6}" class="lab">${(rows.length - reused).toLocaleString('en-GB')} never referred to again</text>
${dots(false, 'not')}
${dots(true, 'kept')}
<line x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" y2="${H - PAD.bottom}" class="ax"/>
${ticks}
<text x="${PAD.left + plot.w / 2}" y="${H - 8}" class="tick" text-anchor="middle">probability the output is still needed verbatim</text>
</svg>
`;

const out = join(here, '..', 'docs', 'distribution.svg');
writeFileSync(out, svg);

// The same plate with the marks left out: everything that does not move —
// ground, floor line, band labels, axis, ticks — so the animated version can
// draw 2,239 points over it and nothing else. Same source, so the frame the
// marks settle onto is the frame the static plate uses.
const frame = svg.replace(dots(false, 'not'), '').replace(dots(true, 'kept'), '');
writeFileSync(join(here, '..', 'docs', 'distribution-frame.svg'), frame);
console.log(`wrote ${out}: ${rows.length} marks, ${reused} reused, ${(svg.length / 1024).toFixed(0)} KB`);

// The same marks as numbers, so the page can draw them settling into the order
// the scorer puts them in. Rounded to whole units of a 1200x420 viewBox, which
// is finer than the 1.5-2.6px dots can show. Deliberately carries no timestamp:
// CI regenerates docs/ and fails on a diff.
/**
 * What an absolute cut would sweep, at every hundredth from the shipped floor
 * to 0.50.
 *
 * The page asserts that "a fixed cut sweeps all of it" and then asks to be
 * believed. It is the one claim on the page whose evidence was already drawn
 * and just not pointed at: the marks are right there, and counting how many of
 * the reused ones fall left of a line is arithmetic over the same array the
 * plate is drawn from.
 */
const SWEEP_FROM = FLOOR;
const SWEEP_TO = 0.5;
const reusedMarks = marks.filter((m) => m.reused);
const sweep: Array<{ at: number; swept: number }> = [];
for (let at = SWEEP_FROM; at <= SWEEP_TO + 1e-9; at += 0.01) {
  const cut = Math.round(at * 100) / 100;
  const px = PAD.left + cut * (W - PAD.left - PAD.right);
  sweep.push({ at: cut, swept: reusedMarks.filter((m) => m.x < px).length });
}

const data = {
  w: W, h: H, pad: PAD, floor: FLOOR, sweep, reusedTotal: reusedMarks.length,
  // Where a mark starts is a scramble, not a measurement, so the page says so.
  // Emitting the seed keeps even the scramble reproducible.
  scatterSeed: 98765,
  x: marks.map((m) => Math.round(m.x)),
  y: marks.map((m) => Math.round(m.y)),
  reused: marks.map((m) => (m.reused ? 1 : 0)),
};
const dataOut = join(here, '..', 'docs', 'distribution-data.js');
writeFileSync(dataOut, `/* Generated by eval/distribution.ts — do not edit. */\nwindow.PLOT = ${JSON.stringify(data)};\n`);
console.log(`wrote ${dataOut}: ${(JSON.stringify(data).length / 1024).toFixed(0)} KB`);

// ── the same sweep, settled into the page ──────────────────────────────────
// Ships at its endpoint, because the endpoint is the argument: with scripts
// blocked a reader sees the cut that would have been made and what it costs,
// not a control waiting to be pressed.
const last = sweep[sweep.length - 1]!;
const share = Math.round((100 * last.swept) / reusedMarks.length);

/**
 * Two pieces, two marker pairs.
 *
 * The readout started inside the overlay and landed on top of the plate's own
 * band labels, in ink meant for paper on a section that is not paper. It reads
 * above the plate now, where it is ordinary text in the flood's own colour, and
 * only the line stays in the plot's coordinate space.
 */
const readout = `    <p class="cut__read">A fixed cut at <b id="cut-at">${last.at.toFixed(2)}</b> would sweep
      <b id="cut-n">${last.swept}</b> of the ${reusedMarks.length} reused outputs with it:
      <b id="cut-pct">${share}%</b> of the work this is here to protect.</p>`;
const line = `      <div class="cut" id="cut" style="--at:${last.at}" aria-hidden="true">
        <div class="cut__line"></div>
      </div>`;

const pagePath = join(here, '..', 'docs', 'index.html');
let page = readFileSync(pagePath, 'utf8');
for (const [name, body] of [['cutread', readout], ['cut', line]] as const) {
  const openMark = page.includes(`    <!-- ${name}:render -->\n`)
    ? `    <!-- ${name}:render -->\n` : `      <!-- ${name}:render -->\n`;
  const closeMark = openMark.trimEnd() === `<!-- ${name}:render -->`
    ? `\n${openMark.slice(0, openMark.length - `<!-- ${name}:render -->\n`.length)}<!-- /${name}:render -->`
    : '';
  const from = page.indexOf(openMark);
  const indent = openMark.slice(0, openMark.indexOf('<'));
  const close = `\n${indent}<!-- /${name}:render -->`;
  const to = page.indexOf(close);
  if (from < 0 || to < 0) throw new Error(`no ${name}:render markers in ${pagePath}`);
  page = page.slice(0, from + openMark.length) + body + page.slice(to);
}
writeFileSync(pagePath, page);
console.log(`spliced the cut overlay: ${last.swept}/${reusedMarks.length} swept at ${last.at}`);
