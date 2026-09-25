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
/** The section a fenced block sits in, so its scroll region can be named. */
let section = 'Evaluation';
const blockCount = new Map<string, number>();

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
    // Focusable, named region: these blocks scroll sideways, so a keyboard must be able
    // to reach them and a screen reader must be able to say which section they belong to.
    const nth = (blockCount.get(section) ?? 0) + 1;
    blockCount.set(section, nth);
    const label = escape(`${section} — measured output${nth > 1 ? ` (${nth})` : ''}`);
    blocks.push(
      `<div class="scroller" tabindex="0" role="region" aria-label="${label}"><pre>${escape(body.join('\n'))}</pre></div>`,
    );
    continue;
  }
  const heading = /^(#{1,3})\s+(.*)$/.exec(line);
  if (heading) {
    flush();
    const level = heading[1]!.length;
    const title = heading[2]!;
    if (level === 1) { blocks.push(`<h1>${inline(title)}</h1>`); continue; }
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (level === 2) {
      section = title.replace(/\s+—.*$/, '');
      contents.push({ id, title: section });
    }
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
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Bodoni+Moda:opsz,wght@6..96,400;6..96,500;6..96,700&family=Literata:opsz,wght@7..72,400;7..72,500&display=swap" rel="stylesheet">
<style>
:root{
  color-scheme: light;
  /* The flooded ground the masthead sits in, and the type that survives on it. */
  --flood: oklch(0.38 0.150 34);
  --on-flood: oklch(0.983 0.004 45); --on-flood-2: oklch(0.80 0.06 40);
  --flood-rule: oklch(0.55 0.10 38);
  --paper: oklch(0.983 0.004 45); --paper-sunk: oklch(0.957 0.006 45);
  --rule: oklch(0.885 0.008 45); --rule-firm: oklch(0.760 0.010 45);
  --ink: oklch(0.245 0.012 45); --ink-2: oklch(0.430 0.011 45); --ink-3: oklch(0.470 0.010 45);
  --accent: oklch(0.505 0.190 38); --accent-ink: oklch(0.395 0.140 38);
  --sans: 'Archivo', ui-sans-serif, system-ui, sans-serif;
  --serif: 'Literata', Georgia, serif;
  --display: 'Bodoni Moda', 'Bodoni 72', Didot, Georgia, serif;
  --mono: ui-monospace, Menlo, Consolas, monospace;
  --measure: 1080px; --gutter: clamp(20px, 5vw, 64px);
}
*,*::before,*::after{ box-sizing: border-box; }
body{
  margin:0; background: var(--paper); color: var(--ink);
  font-family: var(--serif); font-size: 1.0625rem; line-height:1.62;
  padding: env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0);
}
img{ max-width:100%; } [hidden]{ display:none !important; }
main{
  width:100%; max-width: var(--measure); margin-inline:auto;
  padding-inline: var(--gutter); padding-block-start: clamp(32px, 4.5vw, 56px);
}
/* Full-bleed ground; the reading measure is held by the wrapper inside it. */
header{ background: var(--flood); color: var(--on-flood); }
.wrap{
  width:100%; max-width: var(--measure); margin-inline:auto; padding-inline: var(--gutter);
  padding-block: clamp(44px, 7vw, 104px) clamp(18px, 2.5vw, 28px);
}
/* Optical sizing pinned to the text cut: Bodoni's large-opsz hairlines — the em-dash
   among them — fall below one device pixel and drop out of the raster entirely. */
h1{
  font-family: var(--display); font-optical-sizing:none; font-weight:500; color: var(--on-flood);
  font-size: clamp(3rem, 1.3rem + 6vw, 6rem); line-height:0.92; letter-spacing:-0.015em;
  text-wrap: balance; margin:0 0 clamp(24px, 3.5vw, 40px);
}
h2{
  font-family: var(--display); font-optical-sizing:none; font-weight:500;
  font-size: clamp(1.85rem, 1.25rem + 2.3vw, 2.9rem); line-height:1.06; letter-spacing:-0.01em;
  text-wrap: balance; margin: clamp(56px, 8vw, 88px) 0 14px; padding-top: 24px;
  border-top: 2px solid var(--ink); scroll-margin-top: 16px;
}
h2 code{ font-size:0.5em; font-weight:400; color: var(--ink-2); letter-spacing:0; }
h3{ font-family: var(--display); font-optical-sizing:none; font-weight:700; font-size:1.35rem; line-height:1.2; margin: 32px 0 8px; }
p{ max-width: 68ch; margin: 0 0 16px; }
a{ color: var(--accent-ink); text-underline-offset:3px; }
a:hover{ color: var(--accent); }
:focus-visible{ outline: 2px solid var(--accent); outline-offset:3px; }
header :focus-visible{ outline-color: var(--on-flood); }
code{ font-family: var(--mono); font-size:0.9em; }
em{ color: var(--ink-2); }
.contents{
  display:flex; flex-wrap:wrap; gap:8px 24px;
  border-top:1px solid var(--flood-rule); padding-top:14px;
}
.contents a{
  font-family: var(--sans); font-size:0.875rem; font-weight:500; color: var(--on-flood-2);
  text-decoration:none; padding-block:6px; border-bottom:1px solid transparent;
}
.contents a:hover, .contents a:focus-visible{ color: var(--on-flood); border-bottom-color: var(--on-flood); }
.contents .back{ font-weight:600; letter-spacing:0.01em; border-bottom-color: currentColor; }
.scroller{
  overflow-x:auto; overscroll-behavior-x: contain; margin: 0 0 24px;
  border:1px solid var(--ink-3); background: var(--paper-sunk);
}
pre{
  margin:0; padding:16px; font-family: var(--mono);
  font-size:0.8125rem; line-height:1.55; font-variant-ligatures:none; color: var(--ink);
}
footer{
  width:100%; max-width: var(--measure); margin: 64px auto 0;
  padding-inline: var(--gutter); padding-block:24px 64px;
  border-top:2px solid var(--ink);
  font-family: var(--sans); font-size:0.875rem; color: var(--ink-2);
}
footer p{ max-width: 68ch; }
@media (max-width: 640px){
  :root{ --gutter: 16px; }
  html, body{ max-width:100%; overflow-x:hidden; overflow-x:clip; }
  h1{ line-height:0.96; letter-spacing:-0.01em; }
  h2{ padding-top:18px; }
  h2 code{ font-size:0.6em; }
  p{ max-width:none; }
  code{ overflow-wrap:anywhere; }
  .contents{ gap:4px 18px; }
}
@media print{
  :root{
    --paper:#fff; --paper-sunk:#f4f4f4; --ink:#111; --ink-2:#333; --ink-3:#555;
    --flood:#fff; --on-flood:#111; --on-flood-2:#333; --flood-rule:#999;
  }
  body{ font-size:10pt; }
  header{ background:#fff; color:#111; border-bottom:2px solid #111; }
  .wrap{ padding-block: 0 12px; padding-inline: 0; }
  main{ padding-inline: 0; }
  h1{ font-size:30pt; } h2{ font-size:16pt; break-after: avoid; } .scroller{ break-inside: avoid; }
}
</style>
</head>
<body>
<header>
  <div class="wrap">
    ${blocks[0] ?? '<h1>Evaluation results</h1>'}
    <nav class="contents" aria-label="Contents"><a class="back" href="./">← laya-compact</a>${nav}</nav>
  </div>
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
