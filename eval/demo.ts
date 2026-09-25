/**
 * The data behind the demonstration on the landing page.
 *
 * A constructed session, real decisions. Constructed because the page is
 * published and every real transcript on this machine is someone's work; real
 * decisions because the transcript goes through the shipped `compact` with the
 * shipped defaults and nothing here chooses what is dropped. The page says so.
 *
 * Writes `docs/demo-data.js`, which the page reads to animate the calls being
 * scored, and splices the settled rows straight into `docs/index.html` between
 * the `demo:render` markers. The second half exists because the section used to
 * ship an empty `<ol>` and a hard-coded `0`: with scripts blocked it reported
 * "FREED 0 chars / DECIDED 0 of 9" under prose that referred to "the list
 * above". Rendering the end state here makes the no-JS state the true one and
 * leaves the script with nothing to do but replay it.
 *
 * Run: bun eval/demo.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_OPTIONS, compact, freedBy } from '../src/compact.js';
import { FeatureAsker } from '../src/features.js';
import { collectToolCalls } from '../src/state.js';
import type { Message } from '../src/index.js';

const call = (
  id: string, tool: string, input: Record<string, unknown>, output: string, isError = false,
): Message[] => [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output, isError }] },
];

const lines = (count: number, seed: string): string =>
  Array.from({ length: count }, (_, i) => `${seed} line ${i + 1}: ${'x'.repeat(40 + (i % 17) * 3)}`).join('\n');

/** A session with the shape the scorer is judged on: reads, edits, commands, an error. */
const transcript: Message[] = [
  { role: 'user', text: 'the auth test is failing on CI but passes locally. find out why.', toolUses: [] },
  ...call('c1', 'Bash', { command: 'npm test -- auth.spec.ts' },
    `FAIL test/auth.spec.ts\n  ✕ rejects an expired token (12 ms)\n\n  expected 401, got 200\n\n${lines(90, 'stack')}`, true),
  ...call('c2', 'Read', { file_path: 'src/auth.ts' }, lines(420, 'src/auth.ts')),
  ...call('c3', 'Grep', { pattern: 'JWT_SECRET', path: 'src' },
    'src/auth.ts:12:const SECRET = process.env.JWT_SECRET;\nsrc/config.ts:31:JWT_SECRET: str(),'),
  ...call('c4', 'Read', { file_path: 'src/config.ts' }, lines(160, 'src/config.ts')),
  ...call('c5', 'Bash', { command: 'git log --oneline -20 -- src/auth.ts' }, lines(20, 'commit')),
  ...call('c6', 'Read', { file_path: '.github/workflows/ci.yml' }, lines(70, 'ci.yml')),
  ...call('c7', 'Bash', { command: 'gh run view 4821 --log | tail -60' }, lines(600, 'runner')),
  ...call('c8', 'Edit', { file_path: 'src/auth.ts', old_string: 'jwt.verify(token, SECRET)', new_string: 'jwt.verify(token, SECRET, { clockTolerance: 0 })' },
    'Applied 1 edit to src/auth.ts'),
  ...call('c9', 'Bash', { command: 'npm test -- auth.spec.ts' },
    `PASS test/auth.spec.ts\n  ✓ rejects an expired token (9 ms)\n\n${lines(30, 'summary')}`),
  { role: 'assistant', text: 'CI runs in UTC+0 and the fixture minted its token with a local offset, so the expiry landed inside jwt’s default 0-second tolerance only on the runner. Pinned the tolerance.', toolUses: [] },
  { role: 'user', text: 'good. now do the same for the refresh path.', toolUses: [] },
];

const result = await compact(transcript, new FeatureAsker(), { preserveRecentMessages: 2 });
const calls = collectToolCalls(transcript, 2);
const byId = new Map(calls.map((c) => [c.id, c]));
const decisions = result.decisions.map((decision) => {
  const source = byId.get(decision.id)!;
  return {
    id: decision.id,
    tool: source.tool,
    target: String(
      source.input['file_path'] ?? source.input['command'] ?? source.input['pattern'] ?? '',
    ).slice(0, 52),
    chars: source.resultChars,
    isError: source.isError,
    pinned: source.pinned,
    action: decision.action,
    reason: decision.reason,
    // How many characters this decision actually removes, from the same
    // function `applyDecisions` uses — so the page adds up rather than
    // reimplementing the head rule and drifting from it.
    freed: freedBy(source, decision.action, DEFAULT_OPTIONS.truncateHeadChars),
    keepResult: Number(decision.keepResult.toFixed(3)),
    keepCall: Number(decision.keepCall.toFixed(3)),
  };
});

/** What the row says it did. A result short enough to fit inside the retained
 * head is not shortened at all, so calling it "head only" would overstate it. */
const outcome = (d: (typeof decisions)[number]): string =>
  d.reason === 'too small' ? 'too small'
    : d.freed === 0 ? 'kept'
    : d.action === 'drop_call' ? 'dropped' : 'head only';
const stateName = (d: (typeof decisions)[number]): string =>
  d.reason === 'too small' ? 'small'
    : d.freed === 0 ? 'kept'
    : d.action === 'drop_call' ? 'dropped' : 'head';
const widest = Math.max(...decisions.map((d) => d.chars));
/** Bar width is the call's share of the largest output. */
const share = (d: (typeof decisions)[number]): number =>
  Math.max(3, Math.round((100 * d.chars) / widest));
/** scaleX of what survived. `freed` counts the tool input too, so a tiny result
 * can free more characters than it holds; the bar shows the result, hence the clamp. */
const keep = (d: (typeof decisions)[number]): number =>
  d.chars === 0 ? 1 : Math.max(0, Math.min(1, (d.chars - d.freed) / d.chars));

const shown = decisions.map((d) => ({
  ...d, outcome: outcome(d), state: stateName(d), share: share(d), keep: Number(keep(d).toFixed(4)),
}));

// Deliberately carries no timestamp and no timing: CI regenerates this file and
// fails on a diff, so anything that changes between two identical runs would
// turn that check into noise. Scoring speed is measured in `eval/sessions.ts`.
const data = {
  stats: {
    calls: result.stats.calls,
    outputChars: calls.reduce((sum, c) => sum + c.resultChars, 0),
    charsBefore: result.stats.charsBefore,
    charsAfter: result.stats.charsAfter,
    kept: result.stats.kept,
    resultsDropped: result.stats.resultsDropped,
    callsDropped: result.stats.callsDropped,
  },
  decisions: shown,
};

const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const out = join(docs, 'demo-data.js');
writeFileSync(out, `/* Generated by eval/demo.ts — do not edit. */\nwindow.DEMO = ${JSON.stringify(data, null, 1)};\n`);
console.log(`wrote ${out}`);

// ── the same decisions, rendered into the page ──────────────────────────────
const num = (n: number): string => n.toLocaleString('en-GB');
const esc = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const freedTotal = shown.reduce((sum, d) => sum + d.freed, 0);
const shortened = shown.filter((d) => d.freed > 0).length;

const markup = [
  '<div class="demo__bar">',
  `  <p class="demo__stat">Tool output<b>${num(data.stats.outputChars)} chars</b></p>`,
  `  <p class="demo__stat demo__stat--freed">Freed<b><span id="d-freed">${num(freedTotal)}</span> chars</b></p>`,
  `  <p class="demo__stat">Decided<b><span id="d-count">${shown.length}</span> of ${shown.length}</b></p>`,
  // Hidden until the script that drives it is running: a button that cannot
  // replay anything is worse than no button.
  `  <button class="demo__run" type="button" id="d-run" hidden>Replay — ${Math.round((100 * freedTotal) / data.stats.outputChars)}% freed</button>`,
  '</div>',
  '<p class="visually-hidden" id="d-status" role="status" aria-live="polite"></p>',
  '<ol class="demo__list" id="d-list">',
  ...shown.map((d) => '  ' + [
    `<li class="demo__call" data-state="${d.state}">`,
    `<span class="demo__who"><b>${esc(d.tool)}</b><span>${esc(d.target) || '—'}</span></span>`,
    `<span class="demo__track"><span class="demo__fill" style="--w:${d.share}%;--keep:${d.keep}"></span></span>`,
    `<span class="demo__scores">${d.keepResult.toFixed(3)} · ${d.keepCall.toFixed(3)}<br>${num(d.chars)} ch</span>`,
    `<span class="demo__outcome">${d.outcome}</span>`,
    '</li>',
  ].join('')),
  '</ol>',
].map((line) => '    ' + line).join('\n');

const page = join(docs, 'index.html');
const html = readFileSync(page, 'utf8');
const open = '    <!-- demo:render -->\n';
const close = '\n    <!-- /demo:render -->';
const from = html.indexOf(open);
const to = html.indexOf(close, from);
if (from < 0 || to < 0) throw new Error(`no demo:render markers in ${page}`);
writeFileSync(page, html.slice(0, from + open.length) + markup + html.slice(to));
console.log(`spliced ${shown.length} rows into ${page}`);
console.log(`${shortened} of ${shown.length} shortened, ${num(freedTotal)} chars freed`);
console.log(`${data.stats.calls} calls, ${data.stats.charsBefore.toLocaleString()} → ` +
  `${data.stats.charsAfter.toLocaleString()} chars in ${result.stats.ms.toFixed(0)} ms`);
for (const d of decisions) {
  console.log(`  ${d.id.padEnd(4)}${d.tool.padEnd(7)}${String(d.chars).padStart(7)}  ` +
    `${d.keepResult.toFixed(3)} ${d.keepCall.toFixed(3)}  ${d.action.padEnd(12)}${d.reason}`);
}
