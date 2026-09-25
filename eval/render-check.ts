/**
 * Assertions that only a rendered page can make.
 *
 * Three separate critiques found defects no amount of reading the source would
 * catch, because each was a *rendered* fact: a region announced as scrolling
 * that did not scroll, an image whose narrow-screen rule was silently overridden
 * 139 lines later at equal specificity, a column clipping its content while a
 * third of the band sat empty, and section rules 64px wider than every other
 * rule on a page whose hierarchy is rules. Reviewers found all four. Nothing in
 * the repository could.
 *
 * So: load the real page in headless Chromium at two widths, measure, and fail.
 * No browser-automation dependency: it drives the DevTools protocol over the
 * WebSocket client Bun already ships.
 *
 * Run: bun eval/render-check.ts [--keep]
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

/** Runs in the page. Prints one line per check: `PASS|FAIL<TAB>name<TAB>detail`. */
const PROBE = String.raw`
(() => {
  const out = [];
  const say = (ok, name, detail) => out.push((ok ? 'PASS' : 'FAIL') + '\t' + name + '\t' + detail);
  const w = innerWidth;
  const scrolls = (el) => el.scrollWidth > el.clientWidth + 1;

  // A visible hint saying a thing drags, on a thing that cannot drag, is the
  // defect a reviewer found on seven regions at once.
  for (const el of document.querySelectorAll('[tabindex="0"]')) {
    const hint = getComputedStyle(el, '::before').content;
    if (!hint || hint === 'none' || !/drag/.test(hint)) continue;
    const name = (el.getAttribute('aria-label') || el.className || '?').slice(0, 40);
    say(scrolls(el), 'drag hint only where it drags @' + w, name);
  }

  // The one image on the page. At or below 760px it keeps its size and drags.
  const plate = document.querySelector('.plate__scroll');
  if (plate) {
    const img = plate.querySelector('img');
    const shown = Math.round(img.getBoundingClientRect().width);
    say(w > 760 || scrolls(plate), 'the plot can be dragged @' + w, shown + 'px in ' + plate.clientWidth + 'px');
    say(w > 760 || shown > plate.clientWidth, 'the plot keeps its size @' + w, shown + 'px');
  }

  // Nothing may clip its own text.
  let clipped = 0;
  for (const el of document.querySelectorAll('.demo__who span, .row__name, .ledger__claim, .next__what')) {
    if (el.scrollWidth > el.clientWidth + 1) {
      clipped += 1;
      say(false, 'text is not clipped @' + w,
          (el.textContent || '').trim().slice(0, 30) + ' [' + el.clientWidth + '<' + el.scrollWidth + ']');
    }
  }
  if (clipped === 0) say(true, 'no clipped text @' + w, 'scanned');

  // Rules that read as the same rule must start and end together.
  const edges = new Set();
  for (const el of document.querySelectorAll('section.wrap')) {
    const cs = getComputedStyle(el, '::before');
    if (cs.content === 'none' || cs.display === 'none') continue;
    const box = el.getBoundingClientRect();
    edges.add(Math.round(box.left + parseFloat(cs.left)) + ':' + Math.round(box.right - parseFloat(cs.right)));
  }
  for (const el of document.querySelectorAll('.rubric')) {
    const r = el.getBoundingClientRect();
    edges.add(Math.round(r.left) + ':' + Math.round(r.right));
  }
  say(edges.size <= 1, 'rules share their edges @' + w, [...edges].join('  ') || 'none found');

  // Nothing may push the page sideways.
  say(document.documentElement.scrollWidth <= innerWidth + 1, 'no horizontal page scroll @' + w,
      document.documentElement.scrollWidth + ' vs ' + innerWidth);

  // Every figure the page prints as a table cell must be reachable, not clipped
  // off the end of a scroller that cannot scroll.
  for (const el of document.querySelectorAll('.scroller')) {
    const t = el.querySelector('table');
    if (t && t.scrollWidth > el.clientWidth + 1) {
      say(el.scrollWidth > el.clientWidth + 1, 'an overflowing table can scroll @' + w,
          (el.getAttribute('aria-label') || '?').slice(0, 40));
    }
  }

  return out.join('\n');
})();
`;

const dir = mkdtempSync(join(tmpdir(), 'render-check-'));
for (const file of readdirSync(docs)) copyFileSync(join(docs, file), join(dir, file));
const url = `file://${join(dir, 'index.html')}`;

/**
 * `--dump-dom` lays out no viewport at all — `innerWidth` comes back 0 — and
 * `--screenshot` alongside it does not help. So: drive the DevTools protocol
 * directly. Bun ships a WebSocket client, so this needs no dependency.
 */
/** GitHub's runners ship `google-chrome`; this machine has `chromium-browser`. */
function findBrowser(): string {
  const named = process.env['CHROME'];
  const candidates = named
    ? [named]
    : ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable'];
  for (const binary of candidates) {
    try {
      execFileSync('command', ['-v', binary], { shell: true, stdio: 'ignore' });
      return binary;
    } catch { /* not this one */ }
  }
  throw new Error(`no browser found; tried ${candidates.join(', ')} (set CHROME= to override)`);
}

const port = 9333 + (process.pid % 200);
const chrome = spawn(findBrowser(), [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let browserWs = '';
for (let attempt = 0; attempt < 100 && !browserWs; attempt += 1) {
  await sleep(100);
  try {
    const info = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    browserWs = String(info.webSocketDebuggerUrl ?? '');
  } catch { /* not listening yet */ }
}
if (!browserWs) { chrome.kill(); throw new Error('chromium never opened a debugging port'); }

function connect(endpoint: string): {
  send: (method: string, params?: Record<string, unknown>, session?: string) => Promise<any>;
  close: () => void;
} {
  const socket = new WebSocket(endpoint);
  const waiting = new Map<number, (value: any) => void>();
  let id = 0;
  const ready = new Promise<void>((resolve) => { socket.onopen = () => resolve(); });
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)!(message);
      waiting.delete(message.id);
    }
  };
  return {
    send: async (method, params = {}, sessionId) => {
      await ready;
      id += 1;
      const mine = id;
      const answer = new Promise<any>((resolve) => waiting.set(mine, resolve));
      socket.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
      const reply = await answer;
      if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
      return reply.result;
    },
    close: () => socket.close(),
  };
}

const cdp = connect(browserWs);
let failed = 0;
try {
  for (const width of [1400, 390]) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(2500);
    const { result } = await cdp.send('Runtime.evaluate',
      { expression: PROBE, returnByValue: true, awaitPromise: false }, sessionId);
    const lines = String(result?.value ?? '').trim();
    if (!lines) throw new Error(`the probe returned nothing at ${width}px`);
    for (const line of lines.split('\n')) {
      const [verdict, name, detail] = line.split('\t');
      if (verdict === 'FAIL') failed += 1;
      console.log(`${verdict === 'FAIL' ? '\u2717' : '\u2713'} ${(name ?? '').padEnd(40)} ${detail ?? ''}`);
    }
    await cdp.send('Target.closeTarget', { targetId });
  }
} finally {
  cdp.close();
  chrome.kill();
  if (!process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nall rendered checks pass' : `\n${failed} rendered check(s) failed`);
if (failed > 0) process.exit(1);
