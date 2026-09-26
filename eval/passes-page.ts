/**
 * Renders the committed pass fixture into `docs/index.html`.
 *
 * Same contract as `eval/signals-page.ts` and `eval/demo.ts`: read a generated
 * fixture, splice markup between markers, and never let a number be typed into
 * the page by hand. The fixture comes from `eval/passes.ts --publish`, which
 * reads this machine's own transcripts — so the measurement is machine-local
 * and the *rendering* is not, which is what lets `npm run docs` regenerate the
 * figure on a runner and CI's `git diff --exit-code -- docs/` actually see it.
 *
 * It was the page's newest headline figure and the only one bound to nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = { from: number; to: number; ms: number; taken: boolean; why: string };
type Fixture = {
  window: number; at: number; floor: number; maxPasses: number;
  messages: number; sessions: number; looped: number; avoided: number;
  passesMeasured: number; oldBarTakes: number;
  medianMs: number; medianPp: number; slowestMs: number;
  stubShare: number[]; rows: Row[];
};

const dir = import.meta.dirname;
const f = JSON.parse(readFileSync(join(dir, 'fixtures', 'passes.json'), 'utf8')) as Fixture;

const taken = f.rows.filter((row) => row.taken);
const ordinal = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
  'eighth', 'ninth', 'tenth'][taken.length - 1] ?? `${taken.length}th`;

const bar = (row: Row, index: number): string => {
  const label = row.taken ? `pass ${index + 1}` : 'hand over';
  const why = row.why === 'floor'
    ? `below the ${f.floor}&#8209;point floor`
    : `${f.maxPasses} passes is the ceiling`;
  const back = (row.from - row.to).toFixed(1);
  const note = row.taken
    ? `<span class="ladder__num">&#8722;${back}<span class="ladder__unit">pts</span></span>` +
      `<span class="ladder__ms">${row.ms}&#8239;ms</span>`
    : `<span class="ladder__num ladder__num--under">&#8722;${back}<span class="ladder__unit">pts</span></span>` +
      `<span class="ladder__ms">${why}</span>`;
  return `      <li class="ladder__row${row.taken ? '' : ' ladder__row--over'}">` +
    `<span class="ladder__label">${label}</span>` +
    `<span class="visually-hidden">held ${row.to.toFixed(1)}% of the window, </span>` +
    // The bar says exactly what the two numbers beside it say, so a screen
    // reader is read the numbers and not two empty spans.
    `<span class="ladder__track" aria-hidden="true"><span class="ladder__held" style="--w:${row.to.toFixed(1)}%"></span>` +
    `<span class="ladder__back" style="--l:${row.to.toFixed(1)}%;--w:${back}%"></span></span>` +
    note + '</li>';
};

// The sentence is generated too. It carried "six" as prose beside a figure that
// draws however many passes the measurement found, which is exactly the kind of
// number this page does not let anyone type.
/**
 * The stub-share spark.
 *
 * `stubShare` is seven measured points and the page summarised them as "flat at
 * about seven after that", which is a sentence asking to be believed about a
 * shape. Drawn, the shape argues for itself: up for two passes, then level.
 *
 * Coordinates are computed here and written into the markup, so the figure is
 * correct with scripts off; `app.js` only draws the line on, and only when the
 * reader has not asked for less motion. `pathLength` is normalised to 1 so the
 * draw-on is one dash-offset transition rather than a measured path length.
 */
const CEIL = 10;      // per cent, the top of the y axis — the data peaks at 8.3
const W = 100, H = 26;
/**
 * The plot starts at x=8 so the axis has room to name itself. Without the
 * ceiling written on the figure the line sits near the top of its box and reads
 * as "most results are notes", which is the opposite of what it measures.
 */
const X0 = 8;
const points = f.stubShare.map((share, index) => [
  X0 + (index / (f.stubShare.length - 1)) * (W - X0),
  H - (share / CEIL) * H,
] as const);
const peak = Math.max(...f.stubShare);
const spark = `<figure class="spark">
      <svg class="spark__plot" viewBox="0 0 ${W} ${H + 1}" role="img"
        aria-label="Share of surviving tool results that is a note, by pass: ${
          f.stubShare.map((share) => `${share}%`).join(', ')}. The axis runs from zero to ${CEIL} per cent.">
        <text class="spark__tick" x="${X0 - 2}" y="1.6" text-anchor="end">${CEIL}%</text>
        <text class="spark__tick" x="${X0 - 2}" y="${H}" text-anchor="end">0</text>
        <line class="spark__base" x1="${X0}" y1="${H}" x2="${W}" y2="${H}"></line>
        <path class="spark__line" pathLength="1" fill="none"
          d="${points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')}"></path>
        ${points.map(([x, y], i) =>
          `<circle class="spark__dot" r="1.1" cx="${x.toFixed(1)}" cy="${
            y.toFixed(1)}" style="--i:${i}"></circle>`).join('\n        ')}
      </svg>
      <p class="spark__axis" aria-hidden="true"><span>pass 1</span><span class="spark__peak">peak ${
        peak}%</span><span>pass ${f.stubShare.length}</span></p>
      <figcaption class="caption">Share of surviving tool results that is a note, per pass. It rises
        for two passes and then levels: fresh output arrives between passes at about the rate the loop
        makes stubs. Seven passes deep the transcript is still
        ${(100 - f.stubShare[f.stubShare.length - 1]!).toFixed(0)}% intact results, which is why there
        is no dial for it.</figcaption>
    </figure>`;
const markup = `  <p>
    One compaction is not the product; the loop is. The engine asks at ${f.at}% of the window, this
    answers, you keep working, and it asks again. Each answer costs about
    <span class="num val">${f.medianMs}&#8239;ms</span> and hands back
    <span class="num val">${f.medianPp.toFixed(0)} points</span> of window, so the model
    summary, which is a model call and rewrites your session into prose, runs after the
    ${ordinal} of them rather than the first.
  </p>
  <ol class="ladder" id="ladder" style="--at:${f.at}%;--floor:${f.at - f.floor}%">
    <li class="ladder__scale" aria-hidden="true"><span></span><span class="ladder__marks">
      <span class="ladder__mark ladder__mark--floor">floor ${f.at - f.floor}%</span>
      <span class="ladder__mark ladder__mark--at">asks at ${f.at}%</span>
    </span></li>\n${f.rows.map(bar).join('\n')}\n  </ol>
  <p class="caption">One real session of ${f.messages.toLocaleString()} messages, replayed against a
    ${f.window / 1000}k&#8209;token window. The dark part of each bar is what the session was still
    holding; the red part is what that pass handed back. Of ${f.sessions} sessions measured on one
    machine, ${f.looped} looped at all, and between them the loop answered <b>${f.avoided}</b>
    compactions that would otherwise each have been a model summary. A dated snapshot of one
    machine's transcripts, which grow as you work. <code>npm run dry-run</code> re-runs it
    on yours.</p>
  <h3 class="ladder__h3">Why a percentage of the window, and not of the session</h3>
  <p>
    The rule used to be <code>minReductionRatio: 0.25</code>: take the pass if it removed a quarter
    of the transcript. Replayed on real sessions that bar took
    <span class="num val">${f.oldBarTakes}</span> of <span class="num val">${f.passesMeasured}</span>
    passes. Every one went to the model summary while this could still free ${f.medianPp.toFixed(0)}
    points of window in under ${f.slowestMs}&#8239;ms.
  </p>
  <p>
    The unit was the mistake. A quarter of a ${f.messages.toLocaleString()}-message session and a
    quarter of a 200-message one are not the same amount of room to keep working in, and room is what
    runs out. Points of the window are comparable, and they are the same unit as the ${f.at}% trigger,
    which makes the rule its own guard: the dashed line above is the floor, and a pass is only taken
    if it lands below it. Growing back through those ${f.floor} points is what stops a compaction on
    every turn.
  </p>
  <p>
    The ceiling is <code>maxPasses: ${f.maxPasses}</code>, and on the session drawn above it is what
    ends the loop rather than the floor. That is deliberate: what
    <a href="evidence.html#checked">deferring the summary costs</a> is not measured, and a backstop
    whose value is a judgement should be the conservative one.
  </p>
  <p>
    Every dropped result leaves a note and notes are never removed, so the standing worry is that a
    transcript fills up with receipts. Measured, it does not.
  </p>
  ${spark}`;

/**
 * The second figure this fixture supports: the model calls that did not happen.
 *
 * The page sold context freed and never sold what deferring a summary is — a
 * model call that does not run. Two of the three numbers here are measured
 * (`avoided`, `medianMs`) and the third is arithmetic the figure shows its
 * working for: a summary asked at `at`% of a `window`-token window reads a
 * transcript of about that many tokens.
 *
 * What is deliberately absent is a duration. How long Claude Code's own summary
 * takes has never been measured here — it is already a *not verified* row on the
 * ledger — so this counts calls and tokens and never seconds. "Saves N minutes"
 * would be the first unmeasured claim on a site whose argument is that it does
 * not make them.
 */
const perSummary = Math.round((f.window * f.at) / 100);
const notSent = perSummary * f.avoided;
const avoided = `  <figure class="avoided" id="avoided">
    <p class="avoided__lead"><b>${f.avoided}</b> engine summaries deferred, across
      <b>${f.looped}</b> of the <b>${f.sessions}</b> sessions measured</p>
    <ol class="avoided__strip" aria-hidden="true">
${Array.from({ length: f.avoided }, (_, i) =>
  `      <li class="avoided__block" style="--i:${i}"></li>`).join('\n')}
    </ol>
    <p class="avoided__sum">
      <span><b class="num" id="av-tokens" data-to="${notSent}">${notSent.toLocaleString('en-GB')}</b>
        input tokens not sent</span>
      <span><b class="num">0</b> tokens spent answering</span>
      <span><b class="num">${f.medianMs}&#8239;ms</b> each, on this machine</span>
    </p>
    <figcaption class="caption">The same ${f.sessions} sessions as the ladder. A summary asked at
      ${f.at}% of a ${f.window / 1000}k&#8209;token window reads a transcript of roughly
      ${perSummary.toLocaleString('en-GB')} tokens and rewrites it into prose; ${f.avoided} of them
      is ${notSent.toLocaleString('en-GB')} input tokens that were never sent anywhere. What ran
      instead took ${f.medianMs}&#8239;ms and sent nothing. <b>How long the engine&#8217;s own summary
      takes is not measured</b>
      (a <a href="evidence.html#checked">standing unverified claim</a>), so this counts calls and
      tokens, and never seconds.</figcaption>
  </figure>`;

const page = join(dir, '..', 'docs', 'index.html');
const html = readFileSync(page, 'utf8');
/** Splices between one pair of markers, and refuses to guess if they are absent. */
function splice(html: string, name: string, body: string): string {
  const open = `  <!-- ${name}:render -->\n`;
  const close = `\n  <!-- /${name}:render -->`;
  const from = html.indexOf(open);
  const to = html.indexOf(close);
  if (from < 0 || to < 0) throw new Error(`no ${name}:render markers in ${page}`);
  return html.slice(0, from + open.length) + body + html.slice(to);
}

writeFileSync(page, splice(splice(html, 'passes', markup), 'avoided', avoided));
console.log(`spliced ${f.rows.length} ladder rows (${taken.length} taken) and ${f.avoided} `
  + `avoided summaries into docs/index.html`);
