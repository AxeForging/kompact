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

## 4. Layout strategy

Asymmetric, left-aligned, single column with a wide measurement band. Reading
order:

1. **Masthead** — what it is, in one sentence, with the install command in reach.
2. **The result** — the AUC comparison as a real chart with **error bars**, on a
   0.5 chance baseline. This is the centrepiece and gets the most space.
3. **What it costs** — tokens freed and scoring latency, on real sessions.
4. **Where it loses** — the silent-truncation finding, the 0.002 near-tie, and
   the compression trade-off against a summary. Same typographic weight as the
   result above. This is the differentiator.
5. **Verification ledger** — each claim and how it was checked, including one
   row that says *not verified*.
6. **Install** and provenance.

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

Deliberately thin. One orchestrated reveal on load: the comparison rows stagger
in and the bars grow from the chance baseline, so the reader watches the gap
open. Click-to-copy on the install line. Hover only for links and the copy
control. No scroll-jacking, no reveal-on-scroll, no counters ticking up —
animating a measured number cheapens it.

## 7. Content requirements

Every figure carries its spread, worst case or n. Specifically: `0.895 ± 0.073`
never appears without `worst split 0.687`; `10/10 splits` never without
`+0.002 on the closest`. Copy is plain and declarative — no "blazing", no "10x",
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
