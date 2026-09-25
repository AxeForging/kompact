---
name: laya-compact
description: Use when working with laya-compact — the local context-compaction plugin that scores tool calls and drops what is no longer needed verbatim. Covers reading its decision log, choosing keepThreshold, calibrating the scorer on your own sessions, switching to a Laya sidecar, and diagnosing a compaction that kept or dropped the wrong thing. Also use when someone asks why compaction removed a tool result, how to make compaction more or less aggressive, or how to re-run the evaluation.
---

# Operating laya-compact

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
import { buildCallState, callContexts, collectToolCalls } from 'laya-compact';
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
| Falls back to the built-in summary | lower `minReductionRatio` | the saving was under it, or this session had little to drop |

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

## Using a Laya sidecar instead

Set `scorer` to `laya`. Expect it to be worse: measured over 10 grouped splits,
the built-in scorer averaged AUC 0.895 against 0.721 for the best Laya
checkpoint and wording. Only worth it with a checkpoint fine-tuned on your own
sessions — the bar is the built-in scorer, not chance. Budget for it too: one
`laya-serve` holds ~4.9 GB and ~5.0 GB of VRAM, starts in 7.1 s, and takes 21.5 s
to score a session the built-in scorer scores in 164 ms.

`phrasing` matters more than the checkpoint. On `typed-decisions`, `direct`
scores 0.721 where `reproducible` scores 0.419.

If the toast says `STATES TRUNCATED`, states are overflowing the checkpoint's
context and those scores were computed on fragments. Lower `maxCallStateTokens`
below the checkpoint's state budget (768 on multilingual, ~320 on english).

## Re-running the evaluation

```sh
npm run eval:results   # regenerates eval/RESULTS.md from every script below
npm run eval:ci        # the same, on the committed fixture, no private data
bun eval/repeat.ts     # 10 grouped splits: mean, sd, worst case, paired wins
bun eval/policy.ts     # the threshold-vs-budget sweep, and the shipped path
bun eval/recovery.ts   # what a wrong drop costs, and how it would be recovered
bun eval/laya-bench.ts # sidecar memory, VRAM, cold start and latency
bun eval/baseline.ts   # cheap-feature baselines and a label-confound check
```

Quote figures from `eval/RESULTS.md`, never from memory of a run:
`test/published-figures.test.ts` parses that file and fails if the README, the
page, the manifest or a source comment disagrees with it.

`eval/repeat.ts` is the number to trust. A single split flatters whatever it
measures — that mistake is recorded in the README, having been made here.
