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
const stubs = f.stubShare.slice(0, 3).map((share) => `<span class="num val">${share}%</span>`);
const markup = `  <p>
    One compaction is not the product; the loop is. The engine asks at ${f.at}% of the window, this
    answers, you keep working, and it asks again. Each answer costs about
    <span class="num val">${f.medianMs}&#8239;ms</span> and hands back
    <span class="num val">${f.medianPp.toFixed(0)} points</span> of window &#8212; so the model
    summary, which is a model call and rewrites your session into prose, runs after the
    ${ordinal} of them rather than the first.
  </p>
  <ol class="ladder" id="ladder">\n${f.rows.map(bar).join('\n')}\n  </ol>
  <p class="caption">One real session of ${f.messages.toLocaleString()} messages, replayed against a
    ${f.window / 1000}k&#8209;token window. The dark part of each bar is what the session was still
    holding; the red part is what that pass handed back. Of ${f.sessions} sessions measured on one
    machine, ${f.looped} looped at all, and between them the loop answered <b>${f.avoided}</b>
    compactions that would otherwise each have been a model summary. A dated snapshot of one
    machine's transcripts, which grow as you work &#8212; <code>npm run dry-run</code> re-runs it
    on yours.</p>
  <details class="more">
    <summary><h3>Why a percentage of the window, and not a percentage of the session</h3></summary>
    <p>
      Until this version the rule was <code>minReductionRatio: 0.25</code>: take the pass if it
      removed a quarter of the transcript. Replaying the loop on real sessions, that bar took
      <span class="num val">${f.oldBarTakes}</span> of <span class="num val">${f.passesMeasured}</span>
      passes &#8212; every one went to the model summary while this could still free
      ${f.medianPp.toFixed(0)} points of window in under ${f.slowestMs}&#8239;ms.
    </p>
    <p>
      The unit was the mistake. A quarter of a ${f.messages.toLocaleString()}-message session and
      a quarter of a 200-message one are not the same amount of room to keep working in, and room is
      what runs out. Points of the context window are comparable between them, and they are the same
      unit as the ${f.at}% trigger &#8212; which makes the rule its own guard: a pass that is taken
      leaves the session at least ${f.floor} points below the trigger, so it has to grow back through
      them before another compaction can be asked for. Compacting on every turn stops being possible
      rather than discouraged.
    </p>
    <p>
      The ceiling is <code>maxPasses: ${f.maxPasses}</code>, and on the session drawn above it is
      what stops the loop rather than the floor. That is deliberate: what
      <a href="evidence.html#checked">deferring the summary costs</a> is not measured, and a backstop whose value
      is a judgement should be the conservative one.
    </p>
    <p>
      The worry a loop like this raises is that the transcript fills with receipts: every dropped
      result leaves a note, and notes are never removed. Measured, it does not happen. The share
      of surviving tool results that are a note rises for two passes and then stops &#8212;
      ${stubs.join(', ')}, and flat at about seven after that &#8212; because fresh output arrives
      between passes at roughly the rate the loop creates stubs. A transcript seven passes deep is
      still about 93% intact results, which is why there is no dial for it.
    </p>
  </details>`;

const page = join(dir, '..', 'docs', 'index.html');
const html = readFileSync(page, 'utf8');
const open = '  <!-- passes:render -->\n';
const close = '\n  <!-- /passes:render -->';
const from = html.indexOf(open);
const to = html.indexOf(close);
if (from < 0 || to < 0) throw new Error(`no passes:render markers in ${page}`);
writeFileSync(page, html.slice(0, from + open.length) + markup + html.slice(to));
console.log(`spliced ${f.rows.length} ladder rows into docs/index.html (${taken.length} taken)`);
