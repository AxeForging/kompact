// Buttons are revealed here for the same reason the Replay button is: with
// scripts blocked the commands are selectable text and a Copy button would be a
// control that cannot act. The announcement lives in a sibling status, not on
// the button -- aria-live on a control makes its own accessible name the live
// region. Wired per block, because there are two.
for (const block of document.querySelectorAll('.cmd')) {
  const command = block.querySelector('pre code');
  const button = block.querySelector('[data-copy]');
  const status = block.querySelector('[role="status"]');
  if (!command || !button) continue;
  button.hidden = false;
  // Each command is its own element now, so the newlines that used to separate
  // them are gone from the markup: `textContent` would hand the clipboard
  // `...kompactcd kompactnpm install`, which pastes as one broken
  // command. Read the lines and put the newlines back.
  const commandText = () => {
    const rows = command.querySelectorAll('.cmd__line, .cmd__gap');
    return rows.length
      ? [...rows].map((row) => row.textContent).join('\n').trim()
      : command.textContent.trim();
  };
  const lines = commandText().split('\n').filter(Boolean).length;
  const many = lines === 1 ? 'One command' : `${lines} commands`;
  button.addEventListener('click', async () => {
    const restore = () => { button.textContent = 'Copy'; delete button.dataset.done; };
    try {
      await navigator.clipboard.writeText(commandText());
      button.textContent = 'Copied';
      button.dataset.done = '1';
      if (status) status.textContent = `${many} copied to the clipboard.`;
      setTimeout(restore, 2000);
    } catch {
      // Clipboard refused (insecure origin, or permission denied). Select the
      // command so the keyboard shortcut works, rather than only apologising.
      const range = document.createRange();
      range.selectNodeContents(command);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'Selected — press Ctrl/⌘C';
      button.dataset.done = '1';
      if (status) status.textContent = `The clipboard refused. ${many} selected — press Ctrl or Cmd C.`;
      setTimeout(restore, 4000);
    }
  });
}

// A scrollable box needs a keyboard handle; a box that fits does not. The
// markup ships the handle so it survives with scripts blocked, and this takes
// it away again wherever there is nothing to scroll to.
const boxes = [...document.querySelectorAll('.scroller, .plate__scroll, .cmd pre')];
const bar = document.querySelector('.contents-bar');
const retune = () => {
  // Anchors have to clear the sticky bar, whose height changes with the width
  // it wraps at: 53px on a laptop, 140px on a phone.
  if (bar) document.documentElement.style.setProperty('--nav-h', `${Math.round(bar.offsetHeight)}px`);
  for (const box of boxes) {
    if (box.scrollWidth > box.clientWidth + 1) {
      box.setAttribute('tabindex', '0');
      box.setAttribute('role', 'region');
      if (box.dataset.label) box.setAttribute('aria-label', box.dataset.label);
    } else {
      box.removeAttribute('tabindex');
      box.removeAttribute('role');
      box.removeAttribute('aria-label');
    }
  }
};
retune();
addEventListener('resize', retune, { passive: true });

// Arriving at a definition costs the reader their place. Back does exist, but a
// reader who has just jumped eight sections is not always sure it will do the
// right thing, so this says so. Shown only when a term was actually jumped to.
const backRow = document.querySelector('.gloss-back');
const backButton = document.getElementById('gloss-back');
if (backRow && backButton) {
  const showBack = () => {
    const term = location.hash.startsWith('#g-') && document.querySelector(location.hash);
    backRow.hidden = !(term && term.tagName === 'DT');
  };
  backButton.addEventListener('click', () => history.back());
  addEventListener('hashchange', showBack);
  showBack();
}

// The evidence page still folds; the landing page does not, and does not ship
// this button at all. Hidden in the markup for the usual reason: with scripts
// blocked it would be a control that cannot act.
const openAll = document.getElementById('open-all');
const folds = [...document.querySelectorAll('details.more')];
if (openAll && folds.length) {
  openAll.hidden = false;
  openAll.setAttribute('aria-pressed', 'false');
  openAll.addEventListener('click', () => {
    const opening = openAll.getAttribute('aria-pressed') !== 'true';
    for (const fold of folds) fold.open = opening;
    openAll.setAttribute('aria-pressed', String(opening));
    openAll.textContent = opening ? 'Close all' : 'Open all';
  });
}

// A link into a folded block should open it. Chromium does this on its own for
// fragment navigation; nothing else is obliged to, and the glossary link relied
// on that behaviour until the glossary became its own section.
const openToHash = () => {
  const target = location.hash && document.querySelector(location.hash);
  if (!target) return;
  for (let block = target.closest('details'); block; block = block.parentElement?.closest('details')) {
    block.open = true;
  }
};
addEventListener('hashchange', openToHash);
openToHash();

/* ── the stream ────────────────────────────────────────────────────────────
   Replays the arrival order `eval/signals-fixture.ts` recorded: for each command
   the recorder saw, which of the six most-repeated shapes it landed on, or none.
   Indices only — no text travels in the data. */
const streamBox = document.getElementById('stream');
const streamData = window.SIGNALS;
if (streamBox && streamData && streamData.stream.length) {
  const list = document.getElementById('stream-list');
  const seenEl = document.getElementById('stream-seen');
  const onceEl = document.getElementById('stream-once');
  const runEl = document.getElementById('stream-run');
  const capEl = document.getElementById('stream-caption');
  const fmt = new Intl.NumberFormat('en-GB');
  const top = streamData.rows[0] ? streamData.rows[0].n : 1;

  const fills = streamData.rows.map((row) => {
    const item = document.createElement('li');
    item.className = 'stream__row';
    const name = document.createElement('code');
    name.textContent = row.sig;
    const track = document.createElement('span');
    track.className = 'stream__track';
    const fill = document.createElement('span');
    fill.className = 'stream__fill';
    track.append(fill);
    const n = document.createElement('span');
    n.className = 'stream__n';
    n.textContent = '0';
    item.append(name, track, n);
    list.append(item);
    return { fill, n };
  });

  capEl.textContent = `${fmt.format(streamData.commands)} commands, from the sessions in the table `
    + `above. The bars are the six shapes that repeated most; the counter beside them is every `
    + `command that landed on a shape nothing else shares — ${fmt.format(streamData.shapes)} shapes `
    + `were recorded and ${streamData.repeated} of them repeated at all.`;

  const paint = (upto) => {
    const counts = streamData.rows.map(() => 0);
    let once = 0;
    for (let i = 0; i < upto; i += 1) {
      const seat = streamData.stream[i];
      // -2 is a shape that repeated but is not one of the six drawn. Counting it
      // here would put it among the commands nothing else shares, which it is not.
      if (seat >= 0) counts[seat] += 1; else if (seat === -1) once += 1;
    }
    counts.forEach((count, i) => {
      fills[i].fill.style.width = `${(count / top) * 100}%`;
      fills[i].n.textContent = fmt.format(count);
    });
    seenEl.textContent = fmt.format(upto);
    onceEl.textContent = fmt.format(once);
  };

  const RUN_MS = 3200;
  let playing = false;
  const settle = () => {
    playing = false;
    paint(streamData.stream.length);
    if (draftBox) draftBox.removeAttribute('data-pending');
    markTop(true);
    label();
  };
  const label = () => { runEl.textContent = playing ? 'Stop' : 'Watch it count'; };
  const play = () => {
    if (playing) return;
    playing = true;
    if (draftBox) draftBox.setAttribute('data-pending', '1');
    markTop(false);
    label();
    const started = performance.now();
    const step = (now) => {
      if (!playing) return;
      const t = Math.min(1, (now - started) / RUN_MS);
      paint(Math.round(t * streamData.stream.length));
      if (t < 1) requestAnimationFrame(step); else settle();
    };
    requestAnimationFrame(step);
    // Same guarantee the plate makes: a run that never gets its frames still
    // lands on the real totals rather than freezing part-way.
    setTimeout(() => { if (playing) settle(); }, RUN_MS + 250);
  };

  const draftBox = document.getElementById('stream-draft');
  const draftText = document.getElementById('stream-draft-text');
  if (draftText) draftText.textContent = streamData.draft;
  // Name the row the file came from. The bars and the draft sat beside each other
  // saying nothing about each other, so the step the whole feature turns on — a
  // shape that repeats becomes a file — was left for the reader to infer.
  const draftLabel = document.getElementById('stream-draft-label');
  if (draftLabel && streamData.top) {
    const sig = document.createElement('code');
    sig.textContent = streamData.top;
    const where = document.createElement('code');
    where.textContent = streamData.path;
    const cmd = document.createElement('code');
    cmd.textContent = 'npm run propose -- --write 1';
    draftLabel.append('The marked row, ', sig, ', is what ', cmd, ' writes to ', where, ':');
  }
  // The row the draft came from, marked once the count settles.
  const markTop = (on) => {
    const first = list.firstElementChild;
    if (first) first.classList.toggle('stream__row--drafted', on);
  };

  // Settled first, so with the script starved the numbers on screen are the true
  // ones rather than a half-run.
  paint(streamData.stream.length);
  markTop(true);
  streamBox.hidden = false;
  // The element ships hidden, so a `#stream` link is resolved by the browser
  // before this runs and lands on whitespace. Put the reader where they asked.
  if (location.hash === '#stream') streamBox.scrollIntoView();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    runEl.hidden = true;
  } else {
    runEl.addEventListener('click', () => { if (playing) settle(); else play(); });
  }
}

// Paper has no disclosure widgets. Every folded block opens for the print and
// goes back to how the reader left it afterwards.
for (const event of ['beforeprint', 'afterprint']) {
  addEventListener(event, () => {
    for (const block of document.querySelectorAll('details.more')) {
      if (event === 'beforeprint') {
        if (!block.open) { block.dataset.wasShut = '1'; block.open = true; }
      } else if (block.dataset.wasShut) {
        block.open = false;
        delete block.dataset.wasShut;
      }
    }
  });
}

// Report which section is being read, in the contents row.
const quick = matchMedia('(prefers-reduced-motion: reduce)');
// Not the Top link: it points at the header, which is on screen at the start, so
// the bar opened every session announcing that you were reading "Top".
const links = [...document.querySelectorAll('.contents a:not(.contents__top)')];
const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
if ('IntersectionObserver' in window && sections.length) {
  const seen = new Map();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) seen.set(entry.target, entry.intersectionRatio);
    let best = null;
    let ratio = 0;
    for (const [element, value] of seen) if (value > ratio) { ratio = value; best = element; }
    links.forEach((a) => {
      const active = best !== null && a.getAttribute('href') === '#' + best.id;
      if (!active) { a.removeAttribute('aria-current'); return; }
      a.setAttribute('aria-current', 'true');
      // The bar is one scrolling row, so from the middle of the document the
      // active item sat past the right edge: measured at 390px, six of the nine
      // entries were off-screen while scrollLeft stayed at 20. A marker nobody
      // can see is the same as no marker.
      const row = a.parentElement;
      if (row && row.scrollWidth > row.clientWidth + 1) {
        const want = a.offsetLeft - (row.clientWidth - a.offsetWidth) / 2;
        row.scrollTo({ left: Math.max(0, want), behavior: quick.matches ? 'auto' : 'smooth' });
      }
    });
  }, { threshold: [0, 0.15, 0.4, 0.75, 1] });
  sections.forEach((section) => observer.observe(section));
}

/* ── the demonstration ──────────────────────────────────────────────────────
   Decisions come from eval/demo.ts, which runs the shipped compactor; nothing
   here decides anything, and nothing here renders anything either. The rows and
   the totals are written into the markup by `npm run docs:demo`, so the section
   is already complete and correct with scripts blocked — which it was not when
   this built the list itself and shipped an empty <ol> and a hard-coded 0.
   All this does is un-hide the button and replay what is already on screen. */
/* ── the plate, settling ──────────────────────────────────────────────────
   The static SVG is what a reader gets with scripts blocked or motion turned
   down, and it stays in the DOM carrying the alt text either way. Where motion
   is allowed, the same 2,239 marks are drawn onto a canvas and moved from a
   scramble to the positions the scorer gives them — which is the one thing this
   page asserts and cannot otherwise show. eval/distribution.ts emits both the
   coordinates and the markless frame, from the same pass that writes the SVG,
   so what settles is exactly what ships. */
const plot = window.PLOT;
const stack = document.getElementById('plate-stack');
const plateCanvas = document.getElementById('plate-canvas');
const plateAnim = document.getElementById('plate-anim');
const slowly = matchMedia('(prefers-reduced-motion: reduce)');

if (plot && stack && plateCanvas && plateAnim && plateCanvas.getContext && !slowly.matches) {
  const ctx = plateCanvas.getContext('2d');
  const n = plot.x.length;
  const left = plot.pad.left;
  const span = plot.w - plot.pad.left - plot.pad.right;

  // Where each mark starts is not data — it is the same marks with their scores
  // taken away — so the seed is published and the caption says so outright.
  let seed = plot.scatterSeed >>> 0;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const from = new Float32Array(n);
  for (let i = 0; i < n; i += 1) from[i] = left + rand() * span;

  const paint = (t) => {
    const e = 1 - Math.pow(1 - t, 4);   // ease-out-quart: settles, never bounces
    ctx.clearRect(0, 0, plot.w, plot.h);
    for (let i = 0; i < n; i += 1) {
      const reused = plot.reused[i] === 1;
      ctx.beginPath();
      ctx.arc(from[i] + (plot.x[i] - from[i]) * e, plot.y[i], reused ? 2.6 : 1.5, 0, 6.2832);
      ctx.fillStyle = reused ? 'rgba(252,249,247,0.95)' : 'rgba(225,177,161,0.62)';
      ctx.fill();
    }
  };

  const RUN_MS = 1600;
  let playing = false;
  // Assigned once the button below exists. Both ends of a run go through it, so
  // a run that finishes on its own puts the button back rather than leaving it
  // reading "Stop".
  let syncLabel = () => {};
  const settle = () => { playing = false; paint(1); syncLabel(); };
  const play = () => {
    if (playing) return;
    playing = true;
    syncLabel();
    const started = performance.now();
    paint(0);
    const step = (now) => {
      if (!playing) return;
      const t = Math.min(1, (now - started) / RUN_MS);
      paint(t);
      if (t < 1) requestAnimationFrame(step); else settle();
    };
    requestAnimationFrame(step);
    // requestAnimationFrame is starved in a background tab, under headless
    // capture, and whenever the compositor is busy — and a plate left frozen
    // part-way through is a picture of nothing. This guarantees it lands on the
    // data whatever happens to the frames.
    setTimeout(() => { if (playing) settle(); }, RUN_MS + 250);
  };

  plateAnim.hidden = false;
  stack.dataset.animating = '1';
  // The caption explaining the scramble only applies where the scramble happens.
  const note = document.getElementById('plate-note');
  if (note) note.hidden = false;
  // Settled, not scrambled. If the observer never fires, or rAF is throttled, or
  // the tab is captured before it scrolls into view, what stays on screen has to
  // be the data — a plate resting on a scramble would be a picture of nothing.
  paint(1);

  const replay = document.createElement('button');
  replay.type = 'button';
  replay.className = 'plate__replay';
  replay.textContent = 'Replay the ordering';
  // A control that can only start a 1.6s animation is not control over it. This
  // stops a run in flight, and stopping settles on the data rather than
  // abandoning a half-drawn scramble.
  syncLabel = () => { replay.textContent = playing ? 'Stop' : 'Replay the ordering'; };
  replay.addEventListener('click', () => { if (playing) settle(); else play(); });
  stack.closest('.plate__scroll').after(replay);

  // Play when it is on screen, not while it is still below the fold.
  if ('IntersectionObserver' in window) {
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) { play(); watch.disconnect(); }
    }, { threshold: 0.35 });
    watch.observe(stack);
  } else play();
}

/* ── the ladder ────────────────────────────────────────────────────────────
   The figure ships settled — every bar is in the markup, written there by
   eval/passes.ts. This only arms it and lets it draw once, in order, when it
   comes on screen, so what a reader sees is six refills of the same window
   rather than six bars that were always there. Nothing here knows any numbers. */
{
  const ladder = document.getElementById('ladder');
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  if (ladder && !still.matches && 'IntersectionObserver' in window) {
    const bars = [...ladder.querySelectorAll('.ladder__back')];
    for (const bar of bars) bar.closest('.ladder__row').classList.add('reveal--armed');
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        watch.disconnect();
        bars.forEach((bar, i) => setTimeout(
          () => bar.closest('.ladder__row').classList.remove('reveal--armed'), i * 170));
      }
    }, { threshold: 0.3 });
    watch.observe(ladder);
  }
}

/* ── figures that hold themselves back until they are looked at ────────────
   Three of them now, all on the same contract: the settled state is already in
   the markup, written there by the generating script, and this only arms the
   figure and lets it play once. With scripts blocked or reduced motion asked
   for, nothing is armed and the figure is simply correct. */
function armOnce(selector, play) {
  const el = document.querySelector(selector);
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;
  el.classList.add('reveal--armed');
  const watch = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      watch.disconnect();
      requestAnimationFrame(() => { el.classList.remove('reveal--armed'); play?.(el); });
    }
  }, { threshold: 0.4 });
  watch.observe(el);
}

armOnce('.spark');
armOnce('#spread');
armOnce('#floorcurve');
armOnce('#bill');

/* ── the cut, sweeping the plate ───────────────────────────────────────────
   Walks the line from the shipped floor to where the markup already leaves it,
   reading the count off the table `eval/distribution.ts` emitted. It never
   computes a figure: the last row of that table is the state in the markup, so
   the sweep can only ever end where the page already says it ends. */
{
  const cut = document.getElementById('cut');
  const sweep = window.PLOT?.sweep;
  const reusedTotal = window.PLOT?.reusedTotal;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  if (cut && sweep?.length && reusedTotal && !still.matches && 'IntersectionObserver' in window) {
    const at = document.getElementById('cut-at');
    const n = document.getElementById('cut-n');
    const pct = document.getElementById('cut-pct');
    const settled = { at: at.textContent, n: n.textContent, pct: pct.textContent };
    const show = (row) => {
      cut.style.setProperty('--at', String(row.at));
      at.textContent = row.at.toFixed(2);
      n.textContent = String(row.swept);
      pct.textContent = `${Math.round((100 * row.swept) / reusedTotal)}%`;
    };
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        watch.disconnect();
        show(sweep[0]);
        const span = 2200, started = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - started) / span);
          const eased = 1 - (1 - t) ** 3;
          if (t < 1) {
            show(sweep[Math.min(sweep.length - 1, Math.round(eased * (sweep.length - 1)))]);
            requestAnimationFrame(step);
          } else {
            // Restore the markup's own text, so a rounding difference here can
            // never leave the page saying something it did not ship.
            cut.style.setProperty('--at', String(sweep[sweep.length - 1].at));
            at.textContent = settled.at;
            n.textContent = settled.n;
            pct.textContent = settled.pct;
          }
        };
        requestAnimationFrame(step);
      }
    }, { threshold: 0.35 });
    watch.observe(cut.closest('.plate') ?? cut);
  }
}

/* The nine blocks fill in sequence and the token count climbs with them. The
   final number is the one already in the markup — this reads it back off the
   element rather than computing it, so the count can never land somewhere the
   page does not say. */
armOnce('#avoided', () => {
  const el = document.getElementById('av-tokens');
  const to = Number(el?.dataset.to);
  if (!el || !Number.isFinite(to)) return;
  const settled = el.textContent;
  const span = 900, started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / span);
    // Same curve as the blocks, so the number arrives when the last one does.
    const eased = 1 - (1 - t) ** 3;
    el.textContent = t < 1
      ? Math.round(to * eased).toLocaleString('en-GB')
      : settled;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});

const demo = window.DEMO;
const list = document.getElementById('d-list');
if (demo && list && list.children.length === demo.decisions.length) {
  const total = demo.stats.outputChars;
  const freedEl = document.getElementById('d-freed');
  const countEl = document.getElementById('d-count');
  const run = document.getElementById('d-run');
  const status = document.getElementById('d-status');
  const nf = new Intl.NumberFormat('en-GB');
  const rows = [...list.children];
  const freedTotal = demo.decisions.reduce((sum, d) => sum + d.freed, 0);
  const shortened = demo.decisions.filter((d) => d.freed > 0).length;

  // Every label, state name and bar geometry below is computed once, in
  // eval/demo.ts, and shipped in demo-data.js — so a replayed row and a
  // server-rendered row cannot disagree about what the decision was.
  const paint = (index, settled) => {
    const d = demo.decisions[index];
    const row = rows[index];
    row.dataset.state = settled ? d.state : 'deciding';
    row.querySelector('.demo__fill').style.setProperty('--keep', settled ? d.keep : 1);
    row.querySelector('.demo__outcome').textContent = settled ? d.outcome : 'scoring…';
  };

  // `runs` makes the announcement differ between presses. It used to repaint
  // byte-identical text, which aria-live discards — so under reduced motion,
  // where nothing else changes either, a press announced nothing at all.
  let runs = 0;
  const settleAll = () => {
    demo.decisions.forEach((_, i) => paint(i, true));
    freedEl.textContent = nf.format(freedTotal);
    countEl.textContent = String(demo.decisions.length);
    // Re-enabled here, not only at load: disabling it in `settleAll` meant the
    // first press killed the control for good and dropped focus to <body>.
    running = false;
    run.textContent = `Replay — ${Math.round((100 * freedTotal) / total)}% freed`;
    runs += 1;
    status.textContent = `Replay ${runs} ${cancelled ? 'stopped early, showing the end state' : 'finished'}. `
      + `${shortened} of ${demo.decisions.length} calls shortened, `
      + `${nf.format(freedTotal)} of ${nf.format(total)} characters freed.`;
  };

  const reset = () => {
    rows.forEach((row) => {
      row.dataset.state = 'pending';
      row.querySelector('.demo__fill').style.setProperty('--keep', 1);
      row.querySelector('.demo__outcome').textContent = 'to score';
    });
    freedEl.textContent = '0';
    countEl.textContent = '0';
  };

  // Lowest keepResult first: the order the budget actually spends in.
  const order = demo.decisions
    .map((d, i) => i)
    .sort((a, b) => demo.decisions[a].keepResult - demo.decisions[b].keepResult);

  const still = matchMedia('(prefers-reduced-motion: reduce)');
  // The page already shows the settled state; the button is the only thing this
  // script adds, so it is hidden in the markup and revealed here.
  run.hidden = false;
  run.textContent = `Replay — ${Math.round((100 * freedTotal) / total)}% freed`;

  let running = false;
  let cancelled = false;
  run.addEventListener('click', () => {
    // Never disabled: `run.disabled = true` while the button had focus blurred
    // it to <body> and nothing gave it back. A second press stops instead.
    if (running) { cancelled = true; return; }
    running = true;
    cancelled = false;
    run.textContent = 'Stop';
    reset();
    let freed = 0;
    let step = 0;
    // Under reduced motion the rows still resolve one at a time and the counter
    // still counts — CSS has already removed every transition, so what changes
    // is content, not movement. Same cadence, nothing sliding.
    const tick = () => {
      if (cancelled || step >= order.length) { settleAll(); return; }
      const index = order[step];
      paint(index, false);
      setTimeout(() => {
        paint(index, true);
        freed += demo.decisions[index].freed;
        freedEl.textContent = nf.format(freed);
        countEl.textContent = String(step + 1);
        step += 1;
        // One announcement per decision would flood a screen reader; the end
        // state is announced once, in `settleAll`.
        tick();
      }, still.matches ? 120 : 340);
    };
    tick();
  });
}
