/**
 * Renders `docs/eval.html` from the generated `eval/RESULTS.md`.
 *
 * So that "see the full evaluation" on the landing page is a link rather than an
 * invitation to clone the repository, and so the long version cannot drift from
 * the scripts: this reads the file `npm run eval:results` writes and nothing else.
 *
 * A deliberately small Markdown subset — headings, paragraphs, fenced blocks,
 * emphasis, inline code and links — because that is all RESULTS.md contains and a
 * dependency for the rest would be a dependency for nothing.
 *
 * Run: bun eval/make-eval-page.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const markdown = readFileSync(join(here, 'RESULTS.md'), 'utf8');

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline spans, applied after escaping so a backtick cannot inject markup. */
const inline = (text: string): string =>
  escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|[\s(])_([^_]+)_/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

const blocks: string[] = [];
const contents: Array<{ id: string; title: string }> = [];
const lines = markdown.split('\n');
let paragraph: string[] = [];

const flush = (): void => {
  if (paragraph.length === 0) return;
  blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
  paragraph = [];
};

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]!;
  if (line.startsWith('```')) {
    flush();
    const body: string[] = [];
    for (i += 1; i < lines.length && !lines[i]!.startsWith('```'); i += 1) body.push(lines[i]!);
    blocks.push(`<div class="scroller"><pre>${escape(body.join('\n'))}</pre></div>`);
    continue;
  }
  const heading = /^(#{1,3})\s+(.*)$/.exec(line);
  if (heading) {
    flush();
    const level = heading[1]!.length;
    const title = heading[2]!;
    if (level === 1) { blocks.push(`<h1>${inline(title)}</h1>`); continue; }
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (level === 2) contents.push({ id, title: title.replace(/\s+—.*$/, '') });
    blocks.push(`<h${level} id="${id}">${inline(title)}</h${level}>`);
    continue;
  }
  if (line.trim() === '') { flush(); continue; }
  paragraph.push(line.trim());
}
flush();

const nav = contents.map(({ id, title }) => `<a href="#${id}">${escape(title)}</a>`).join('');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>laya-compact — the full evaluation</title>
<meta name="description" content="Every number laya-compact publishes, with the script that produced it: ranking quality over ten grouped splits, the decision-policy sweep, what a wrong drop costs, and what the optional sidecar costs to run.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Big+Shoulders+Display:wght@600;700;800&family=Literata:opsz,wght@7..72,400;7..72,500&display=swap" rel="stylesheet">
<style>
:root{
  color-scheme: light;
  --paper: oklch(0.983 0.004 45); --paper-sunk: oklch(0.957 0.006 45);
  --rule: oklch(0.885 0.008 45); --rule-firm: oklch(0.760 0.010 45);
  --ink: oklch(0.245 0.012 45); --ink-2: oklch(0.430 0.011 45); --ink-3: oklch(0.470 0.010 45);
  --accent: oklch(0.505 0.190 38); --accent-ink: oklch(0.395 0.140 38);
  --sans: 'Archivo', ui-sans-serif, system-ui, sans-serif;
  --serif: 'Literata', Georgia, serif;
  --display: 'Big Shoulders Display', 'Archivo Narrow', 'Liberation Sans Narrow', Impact, sans-serif;
}
*,*::before,*::after{ box-sizing: border-box; }
body{
  margin:0; background: var(--paper); color: var(--ink);
  font-family: var(--serif); font-size: 1.0625rem; line-height:1.62;
  padding: env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0);
}
img{ max-width:100%; } [hidden]{ display:none !important; }
main, header{ width:100%; max-width: 1080px; margin-inline:auto; padding-inline: clamp(20px, 5vw, 64px); }
header{ padding-block: clamp(32px, 5vw, 64px) 24px; }
h1{
  font-family: var(--display); font-weight:800; text-transform:uppercase;
  font-size: clamp(2.6rem, 1.6rem + 4.4vw, 5rem); line-height:0.88; letter-spacing:-0.005em; margin:0 0 16px;
}
h2{
  font-family: var(--display); font-weight:700; font-size: clamp(1.8rem, 1.3rem + 2.1vw, 2.9rem);
  line-height:0.99; margin: 64px 0 12px; padding-top: 24px; border-top: 2px solid var(--ink);
}
h3{ font-family: var(--display); font-weight:600; font-size:1.4rem; margin: 32px 0 8px; }
p{ max-width: 68ch; margin: 0 0 16px; }
a{ color: var(--accent-ink); text-underline-offset:3px; }
a:hover{ color: var(--accent); }
:focus-visible{ outline: 2px solid var(--accent); outline-offset:3px; }
code{ font-family: ui-monospace, Menlo, Consolas, monospace; font-size:0.9em; }
em{ color: var(--ink-2); }
.back{
  font-family: var(--sans); font-size:0.875rem; font-weight:600; letter-spacing:0.01em;
  text-decoration:none; color: var(--ink); border-bottom:1px solid var(--rule-firm);
}
.back:hover{ color: var(--accent-ink); }
.contents{ display:flex; flex-wrap:wrap; gap:8px 24px; border-top:1px solid var(--rule); padding-top:12px; }
.contents a{
  font-family: var(--sans); font-size:0.875rem; font-weight:500; color: var(--ink-2);
  text-decoration:none; padding-block:6px; border-bottom:1px solid transparent;
}
.contents a:hover{ color: var(--accent-ink); border-bottom-color: var(--accent); }
.scroller{
  overflow-x:auto; overscroll-behavior-x: contain; margin: 0 0 24px;
  border:1px solid var(--rule); background: var(--paper-sunk);
}
pre{
  margin:0; padding:16px; font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size:0.8125rem; line-height:1.55; font-variant-ligatures:none; color: var(--ink);
}
footer{
  border-top:2px solid var(--ink); margin-top:64px; padding-block:24px 64px;
  font-family: var(--sans); font-size:0.875rem; color: var(--ink-2);
}
@media print{
  :root{ --paper:#fff; --paper-sunk:#f4f4f4; --ink:#111; }
  body{ font-size:10pt; } h2{ break-after: avoid; } .scroller{ break-inside: avoid; }
}
</style>
</head>
<body>
<header>
  ${blocks[0] ?? '<h1>Evaluation results</h1>'}
  <nav class="contents" aria-label="Contents"><a class="back" href="./">← laya-compact</a>${nav}</nav>
</header>
<main>
${blocks.slice(1).join('\n')}
</main>
<footer>
  <p>Generated from <code>eval/RESULTS.md</code>, which <code>npm run eval:results</code> writes by
  running the scripts. Nothing on this page was typed by hand.</p>
</footer>
</body>
</html>
`;

const out = join(here, '..', 'docs', 'eval.html');
writeFileSync(out, page);
console.log(`wrote ${out}: ${contents.length} sections, ${(page.length / 1024).toFixed(0)} KB`);
