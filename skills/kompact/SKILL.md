---
name: kompact
description: Use when working with kompact — the local context-compaction plugin that scores tool calls and drops what is no longer needed verbatim. Covers reading its decision log, choosing keepThreshold, calibrating the scorer on your own sessions, tuning how often it defers the model summary, and diagnosing a compaction that kept or dropped the wrong thing. Also use when someone asks why compaction removed a tool result, how to make compaction more or less aggressive, or how to re-run the evaluation, or how to see what they keep repeating and turn it into a skill.
---

# Operating kompact

It scores every tool call before a compaction and keeps what is still needed
verbatim. Two `noul` probabilities per call, three outcomes:

| outcome | when | what survives |
|---|---|---|
| `keep` | P(result needed) >= `keepThreshold`, **or** the reduction target is already met | everything |
| `drop_result` | only P(call needed) clears it, **or** the tool mutates something | the call, plus the first `truncateHeadChars` of its output |
| `drop_call` | neither clears it | nothing; the tool can be re-run |

Two rules the scorer does not get a vote on:

- **A mutating call is never dropped.** `Edit`, `Write`, `MultiEdit` and
  `NotebookEdit` keep their call whatever the probabilities say; only their
  output can go. The output is worth nothing — 1 of 138 in the labelled corpus
  was ever needed verbatim — but the input is the only record the change
  happened, and re-running an edit is not a way to recover it.
- **`keepThreshold` is a floor, not a cut.** Nothing at or above it is dropped,
  whatever the reduction target asks for.

A dropped result is usually not gone outright — the head survives and the tool
can be re-run. Usually, not always: when a result scores below the floor the
call often does too, and then the whole thing goes. Measured on the corpus, the
shipped defaults drop 10 of the 78 outputs that turned out to be reused, 0.56 a
session, and none of those ten kept a head. That asymmetry is still the safety
argument: a wrong keep costs context, a wrong drop costs work.

## "Why was this dropped?"

Every compaction logs one entry per call:

```
t12:Bash:drop_result/call=0.88/result=0.03
```

That is call `t12`, a `Bash`, whose output scored 0.03 against a floor of 0.1 —
so its result went, while `call=0.88` kept the call itself.
Read the state it was scored on by rebuilding it:

```ts
import { buildCallState, callContexts, collectToolCalls } from 'kompact';
```

The scorer sees only: the tool, what it acted on, output size as words, how far
back it sits, whether it errored, whether a later call changed or re-read the
same target. If a decision looks wrong, one of those is usually wrong first —
check `targetTouchedAfter` and the size bucket before blaming the model.

## Making it more or less aggressive

Two dials, and `targetReduction` is the one to reach for first. It says what
fraction of the droppable tool output to free; calls are dropped lowest-score
first until it is met, then dropping stops. `keepThreshold` is the floor that
overrides it.

| symptom | change | why |
|---|---|---|
| Dropping things you needed | **raise `keepThreshold`** to 0.15 or 0.2 | more calls sit above the floor and become untouchable |
| Not freeing enough context | **raise `targetReduction`** to 0.7 | 0.7 frees 52.9% against 0.5's 42.4%, and keeps 82.1% of reused outputs against 84.6% |
| Freeing far too much | **lower `targetReduction`** | the floor alone frees very little: floor 0.05 frees 8.6% |
| Compaction never triggers | lower `compactAtPercent` | it only fires above that share of the window |
| Falls back to the built-in summary | lower `minFreedPercent`, or raise `maxPasses` | the pass freed less than that share of the window, or the ceiling was reached and the summary is now due |

Lowering `keepThreshold` does **not** free more. It lowers the floor, so more
calls become droppable, but the budget still stops at `targetReduction`. Earlier
versions of this file said otherwise, from when the threshold was an absolute
cut at 0.5 — which retained 5% of the outputs that mattered, and is why the
policy changed.

## Calibrate on your own sessions

The shipped coefficients were fitted on one person's 41 sessions. A different
tool mix scores differently, so refitting is the expected thing to do, not an
advanced option:

```sh
bun eval/sessions.ts         # first: what it would free here, nothing installed
bun eval/extract-labels.ts   # labels from ~/.claude/projects, no hand-labelling
bun eval/calibrate.ts        # compares shipped vs refit, held out by session
bun eval/calibrate.ts --write
```

It refuses to fit on fewer than 3 sessions or 20 positives — too thin to mean
anything. Read the reported delta before adopting: if the shipped weights were
fitted on *these* sessions, their column is in-sample and flatters itself.

## The neural sidecar it replaced

There is no option that turns it back on. `scorer` and `layaUrl` are read and
ignored, and nothing shipped imports a client, so a settings file left over from
an older version is not an error. It lost on quality — over 10 grouped splits
the built-in scorer averaged AUC 0.905 against 0.719 for the best checkpoint and
wording — and on cost: 7.6 s to start, ~4.9 GB resident, ~1.4 GB of VRAM, and
41.0 s to score the calls the built-in scorer scores in 190 ms.

`eval/` still measures all of it against a live sidecar. `phrasing` is the one
setting that outlived it, because the built-in scorer reads each question's
instructions too: on `typed-decisions`, `direct` scores 0.719 where
`reproducible` scores 0.419.

## Compaction runs more than once before the summary does

The engine asks at `compactAtPercent` (60). A pass is taken when it reclaims at
least `minFreedPercent` (5) percentage points of the context window; below that
the engine's model summary runs instead. `maxPasses` (6) hands over regardless.

The toast says which pass it was and what the pass reclaimed. If compaction
keeps falling back, the pass is freeing less than the floor — lower
`minFreedPercent`, or accept that the transcript is now prose only a summary can
compress. If it stops after six, that is the ceiling and the summary is due.

## Re-running the evaluation

```sh
npm run eval:results   # regenerates eval/RESULTS.md from every script below
npm run eval:ci        # the same, on the committed fixture, no private data
bun eval/repeat.ts     # 10 grouped splits: mean, sd, worst case, paired wins
bun eval/policy.ts     # the threshold-vs-budget sweep, and the shipped path
bun eval/recovery.ts   # what a wrong drop costs, and how it would be recovered
bun eval/sidecar-bench.ts # sidecar memory, VRAM, cold start and latency
bun eval/baseline.ts   # cheap-feature baselines and a label-confound check
```

Quote figures from `eval/RESULTS.md`, never from memory of a run:
`test/published-figures.test.ts` parses that file and fails if the README, the
page, the manifest or a source comment disagrees with it.

`eval/repeat.ts` is the number to trust. A single split flatters whatever it
measures — that mistake is recorded in the README, having been made here.

## "What do I keep repeating?"

`npm run propose` ranks the shapes the plugin has been counting and writes
nothing. `npm run propose -- --write 2,5` drafts those rows as `SKILL.md` files
into `.kompact/proposals/`, which Claude Code does not read — moving one into
`~/.claude/skills/` is deliberate and manual.

Recording starts when the plugin is installed and never looks at transcripts from
before that. Turn it off with `recordSignals: false`.

| Symptom | What it means |
|---|---|
| "No signals recorded yet" | The hook has not run. Check `recordSignals`, and that the plugin is installed. |
| Nothing has repeated enough | The bar is 3 times in 2 sessions. `--min 2 --min-sessions 1` shows what is close. |
| A row groups unrelated work | The signature is too loose. The samples printed under it are how you can tell. |
| The top rows are generic verbs | Expected, and unresolved — see the ledger row on the page. |

To see what it would find before installing anything,
`bun eval/signals-fixture.ts` replays transcripts you already have through the
same code the hook calls, and writes nothing unless given `--out`.
