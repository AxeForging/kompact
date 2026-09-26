/**
 * The context bill, rendered.
 *
 * Section 05 used to lead with a ranked table of shapes, and the top of that
 * table was `sed -n`, which the section then admitted no skill improves. The
 * ranking was not wrong so much as pointed at the wrong noun: a verb repeating
 * says only that files get read. Measured, the cost is in the *target* — the
 * same handful of files arriving in context again, session after session — and
 * that is a number in the currency the rest of this site already trades in.
 *
 * `eval/repetition.ts --publish` writes the fixture by reading this machine's
 * own transcripts; this only draws it, so `npm run docs` regenerates the figure
 * on a runner and CI's `git diff --exit-code -- docs/` sees a stale one.
 *
 * What it must not say: that a skill would recover any of this. Nothing here
 * has measured that, and a skill does not stop you needing to read a file.
 *
 * Run: bun eval/repetition-page.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type File = { path: string; reads: number; sessions: number; tokens: number };
type Fixture = {
  sessions: number; calls: number; tokens: number; seconds: number; tailSeconds: number;
  repeated: { shapes: number; tokens: number; seconds: number };
  files: {
    read: number; reread: number; rereads: number; tokens: number;
    shareOfReadTokens: number; top: File[];
  };
  gates: Array<{ gate: string; calls: number; seconds: number }>;
};

const dir = import.meta.dirname;
const f = JSON.parse(readFileSync(join(dir, 'fixtures', 'repetition.json'), 'utf8')) as Fixture;
const num = (n: number): string => n.toLocaleString('en-GB');
const k = (n: number): string => `${Math.round(n / 1000).toLocaleString('en-GB')}k`;
const mins = (seconds: number): string => `${Math.round(seconds / 60).toLocaleString('en-GB')} min`;

const top = f.files.top;
const widest = Math.max(...top.map((file) => file.tokens));

/**
 * One row per file, the bar in tokens.
 *
 * Reads and sessions sit beside it because they are the two numbers that make
 * the bar mean something: 233 reads of one file across 5 sessions is a thing
 * a reader recognises, and 217k tokens is what it cost them.
 */
const row = (file: File, index: number): string =>
  `      <li class="bill__row" style="--i:${index}">`
  + `<span class="bill__what"><code>${file.path}</code></span>`
  + `<span class="bill__track"><span class="bill__fill" style="--w:${
    (file.tokens / widest).toFixed(4)}"></span></span>`
  + `<span class="bill__tok">${k(file.tokens)}</span>`
  + `<span class="bill__n">${file.reads} reads &#183; ${file.sessions} sess</span></li>`;

const markup = `  <figure class="bill" id="bill">
    <p class="bill__lead"><b>${f.files.reread}</b> of the <b>${num(f.files.read)}</b> files read
      were read more than once. Between them: <b>${num(f.files.rereads)}</b> reads and
      <b>${k(f.files.tokens)}</b> tokens, <b>${f.files.shareOfReadTokens}%</b> of every token this
      machine spent reading a file.</p>
    <ol class="bill__list">
${top.map(row).join('\n')}
    </ol>
    <figcaption class="caption">The files rediscovered most, over ${f.sessions} sessions and
      ${num(f.calls)} tool calls on one machine. Each read is the file arriving in context again.
      This is what the repetition <b>cost</b>, counted from the transcripts &#8212; not what
      anything would save: nothing here has measured whether writing a skill, or a line in
      <code>CLAUDE.md</code>, changes a single one of these reads, and a skill does not stop you
      needing to read a file. One operator&#8217;s transcripts, and a large share of the top row is
      this site being edited. <code>bun eval/repetition.ts</code> runs it on yours.</figcaption>
  </figure>`;

/**
 * The clock, split by what it was waiting for.
 *
 * Repetition turns out to be a context problem far more than a time one, and
 * the split is the evidence: the time it does cost is mostly a person reading
 * a question, which no amount of tooling shortens.
 */
const label: Record<string, string> = {
  machine: 'a tool running', human: 'a person deciding', delegated: 'a subagent working',
};
const clock = `  <p class="fine" id="clock">
    Repetition is <b>${Math.round((100 * f.repeated.tokens) / f.tokens)}%</b> of the tokens and
    <b>${Math.round((100 * f.repeated.seconds) / f.seconds)}%</b> of the time. The time is the
    smaller half and the less fixable: of ${mins(f.seconds)} of waiting across those sessions,
${f.gates.map((gate) => `    ${mins(gate.seconds)} was ${label[gate.gate] ?? gate.gate} `
  + `(${num(gate.calls)} calls)`).join(',\n')}. Gaps longer than
    ${f.tailSeconds}&#8239;s are counted as ${f.tailSeconds}&#8239;s, because a result arriving an
    hour later is a session left open rather than a tool that ran for an hour.
  </p>`;

const page = join(dir, '..', 'docs', 'evidence.html');
let html = readFileSync(page, 'utf8');
for (const [name, body] of [['bill', markup], ['clock', clock]] as const) {
  const open = `  <!-- ${name}:render -->\n`;
  const close = `\n  <!-- /${name}:render -->`;
  const from = html.indexOf(open);
  const to = html.indexOf(close);
  if (from < 0 || to < 0) throw new Error(`no ${name}:render markers in ${page}`);
  html = html.slice(0, from + open.length) + body + html.slice(to);
}
writeFileSync(page, html);
console.log(`spliced the context bill (${top.length} files, ${f.files.reread} reread) `
  + `and the clock into docs/evidence.html`);
