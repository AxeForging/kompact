/**
 * Puts the proposer's own terminal output on the landing page.
 *
 * The second half of this product — what you keep doing, ranked — had no
 * representation anywhere. The page showed research about which shapes repeat;
 * it never showed the report the CLI prints, because on a machine that has not
 * installed the plugin there is nothing to print, and that includes every
 * machine this page was ever built on.
 *
 * So this runs the real command and captures its real stdout. Not a mock-up and
 * not a re-implementation of the formatting: if `eval/propose.ts` changes a
 * column, the page changes with it or `npm run docs` fails on a diff. The input
 * is `eval/fixtures/signals.json`, the same committed corpus the figure above it
 * is drawn from, so a runner with no `~/.claude` renders exactly what a reader
 * would see.
 *
 * Run: bun eval/propose-page.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const fixture = join(here, 'fixtures', 'signals.json');

const output = execFileSync('bun', [join(here, 'propose.ts'), '--file', fixture], {
  encoding: 'utf8',
  cwd: join(here, '..'),
});

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The run line is the command a reader would type, not the absolute path the
 * script echoes back. Everything else is passed through untouched, including
 * the blank lines, because the shape of the report is part of what is being
 * shown.
 */
const lines = output
  .split(fixture).join('eval/fixtures/signals.json')
  .trimEnd()
  .split('\n');

const body = lines
  .map((line) => `<span class="cmd__line">${escape(line) || '&#8203;'}</span>`)
  .join('');

const block = `<!-- propose:render -->
  <div class="cmd">
    <div class="cmd__head">
      <p class="label">shell &#183; the report, from the corpus above</p>
      <button class="copy" type="button" data-copy hidden aria-label="Copy the command that prints this report">Copy</button>
      <p class="visually-hidden" role="status" aria-live="polite"></p>
    </div>
    <pre tabindex="0" data-label="Shell command and the ranked report it prints"><code><span class="cmd__line">npm run propose:demo</span><span class="cmd__gap"></span>${body}</code></pre>
  </div>
  <p class="caption">Real output, captured from <code>eval/propose.ts</code> when this page was
    built, over the same committed corpus as the table above &#8212; not a mock-up.
    <code>npm run propose</code> is the same report over what the recorder saw on your machine,
    which is nothing until the plugin has been installed a while.</p>
  <!-- /propose:render -->`;

const pagePath = join(here, '..', 'docs', 'index.html');
const page = readFileSync(pagePath, 'utf8');
const start = page.indexOf('<!-- propose:render -->');
const end = page.indexOf('<!-- /propose:render -->');
if (start < 0 || end < 0) {
  throw new Error('docs/index.html has no <!-- propose:render --> markers to splice between');
}
writeFileSync(pagePath, page.slice(0, start) + block + page.slice(end + '<!-- /propose:render -->'.length));
console.log(`spliced ${lines.length} lines of propose output into docs/index.html`);
