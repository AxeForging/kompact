# Design brief — laya-compact landing page

Written from the Design Context in `.impeccable.md` and the measured results in
`README.md`. The discovery interview was skipped because its inputs — audience,
job to be done, personality, anti-references, theme — were already established
in those two files.

## 1. Feature summary

A single static page (`docs/index.html`, GitHub Pages, no framework) for
engineers deciding whether to install a local context-compaction plugin. It has
to survive a sceptic reading it for sixty seconds. Its job is not to excite but
to be *believed*.

## 2. Primary user action

Judge the evidence, then copy the install command. Everything else is secondary.

## 3. Design direction

A typeset technical document — a calibration certificate, a standards paper.
Light theme on warm paper, because this is read at a laptop during the workday
and because the dev-tool reflex (dark, neon, glow) would read as the overselling
this product argues against.

Hierarchy comes from type scale, weight and space. Not from cards, not from
shadows, not from colour fills. One accent, iron-oxide — AxeForging, forging —
reserved for measured values and honesty markers. If it appears on a heading or
a button for decoration, that is a bug.

**Second pass.** The first version was believable and under-read. The register
rises: a condensed gothic display face against the body serif at greater scale
contrast, so a heading reads as plant lettering stamped on the page rather than
as another paragraph; the accent at full strength rather than held back; and one
piece of motion that carries information. Nothing about the claims gets louder —
the figures went *down* in this pass, not up.

## 4. Layout strategy

Asymmetric, left-aligned, single column with a wide measurement band. Reading
order, following Jev's:

1. **Masthead** — what it is, in one sentence, with the install command in reach.
2. **Evidence** — the AUC comparison as a real chart with **error bars**, on a
   0.5 chance baseline.
3. **Demonstration** — one session, before and after, with the decision log
   visible: every call, both its scores, and what happened to it. This is the
   new centrepiece and the only animated element on the page.
4. **What it costs** — tokens freed and scoring latency on real sessions, and
   what the optional sidecar costs in memory, VRAM and seconds.
5. **Where it loses** — the silent-truncation finding, the +0.018 closest split, the
   ten reused outputs it drops anyway, and the compression trade-off against a
   summary. Same typographic weight as the evidence. This is the differentiator.
6. **Verification ledger** — each claim and how it was checked, including the
   rows that say *not verified*.
7. **What's next** — explicitly future tense, and the only place on the page
   allowed to be.
8. **FAQ** — the sceptic's own questions, asked in their words: *Isn't this just
   a heuristic? Why did the neural model lose? Will it delete something I need?
   Do I have to calibrate? How is this different from the built-in `/compact`?*
9. **Install** and provenance.

No feature-card triplet. No centred hero. Nothing wrapped in a card that does
not need a boundary.

## 5. Key states

- **Default**: everything above, static content.
- **Copy affordance**: the install command copies on click; confirmed in place,
  reverting after ~2s. Must work without JS as selectable text.
- **No JavaScript**: the page is fully legible and complete; only copy-to-
  clipboard and the load animation are lost.
- **Reduced motion**: bars and rows appear at final position, no transitions.
- **Narrow viewport (~360px)**: chart rows stack label-above-bar; tables scroll
  horizontally inside their own container, never the page body.
- **Print**: readable as an actual report — this is the one aesthetic the page
  claims, so it should hold on paper.

## 6. Interaction model

Still thin, with one addition that earns its place.

One orchestrated reveal on load: the comparison rows stagger in and the bars grow
from the chance baseline, so the reader watches the gap open. Click-to-copy on the
install line. Hover only for links and the copy control. No scroll-jacking, no
reveal-on-scroll.

**The demonstration animates, and only it.** Press *Score the session* and the
calls are decided in the order the scorer ranks them — lowest first — each row
resolving to kept, head-only or dropped while the freed-character count rises.
The motion is the argument: a static table asserts a ranking, this shows one. The
counter is not a flourish; it counts characters actually leaving the transcript.

The old rule against counters ticking up still holds everywhere else. The test is
whether stopping the animation halfway leaves a reader with a true partial
picture. Here it does. For a hero statistic it would not.

Without JavaScript the demonstration shows its end state, fully labelled. With
`prefers-reduced-motion` it jumps there on the same press, no transitions.

## 7. Content requirements

Every figure carries its spread, worst case or n. Specifically: `0.905 ± 0.078`
never appears without `worst split 0.684`; `10/10 splits` never without
`+0.018 on the closest`. Figures come from `eval/RESULTS.md`, which is generated
— never retyped from a remembered run. Copy is plain and declarative — no "blazing", no "10x",
no exclamation marks. The truncation finding is quoted as data: two rows whose
probabilities are *identical* so the eye sees the point before reading it.

## 8. Recommended references

`spatial-design.md` and `typography.md` (always), `color-and-contrast.md` (the
accent must carry meaning and pass contrast), `motion-design.md` (the single
load orchestration), `responsive-design.md` (chart and tables at 360px),
`ux-writing.md` (the copy is the credibility).

## 9. Open questions

- The chart's x-domain: 0.4–1.0 exaggerates the gap, 0–1 buries it. Start at
  0.5 (chance) and label it as such, which is honest and still legible.
- Whether the verification ledger belongs above or below install. Build it
  below the losses and judge it on screen.
- **Resolved:** the demonstration uses a constructed session, not a real one.
  Every transcript on this machine is someone's work and the page is public.
  Constructed transcript, real decisions, said plainly on the page — and the
  first thing the constructed session revealed was a genuine defect, so it is
  not a toy.
- How much of `eval/RESULTS.md` belongs on a second page. Build `docs/eval.html`
  from the generated file so "see the full evaluation" is a link, and keep the
  landing page to the figures a decision turns on.
