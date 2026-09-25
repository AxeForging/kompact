---
name: laya-compact
description: Use when working with laya-compact — the local context-compaction plugin that scores tool calls and drops what is no longer needed verbatim. Covers reading its decision log, choosing keepThreshold, calibrating the scorer on your own sessions, switching to a Laya sidecar, and diagnosing a compaction that kept or dropped the wrong thing. Also use when someone asks why compaction removed a tool result, how to make compaction more or less aggressive, or how to re-run the evaluation.
---

# Operating laya-compact

It scores every tool call before a compaction and keeps what is still needed
verbatim. Two `noul` probabilities per call, three outcomes:

| outcome | when | what survives |
|---|---|---|
| `keep` | P(result needed) >= `keepThreshold` | everything |
| `drop_result` | only P(call needed) clears it | the call, plus the first `truncateHeadChars` of its output |
| `drop_call` | neither clears it | nothing; the tool can be re-run |

A dropped result is never gone outright — the head survives and the tool can be
re-run. That asymmetry is the whole safety argument: a wrong keep costs context,
a wrong drop costs a re-run.

## "Why was this dropped?"

Every compaction logs one entry per call:

```
t12:Bash:drop_result/call=0.88/result=0.03
```

That is call `t12`, a `Bash`, whose output scored 0.03 against a 0.5 threshold.
Read the state it was scored on by rebuilding it:

```ts
import { buildCallState, callContexts, collectToolCalls } from 'laya-compact';
```

The scorer sees only: the tool, what it acted on, output size as words, how far
back it sits, whether it errored, whether a later call changed or re-read the
same target. If a decision looks wrong, one of those is usually wrong first —
check `targetTouchedAfter` and the size bucket before blaming the model.

## Making it more or less aggressive

Change `keepThreshold`, not the code.

- **Dropping things you needed** → lower it (0.3, 0.2). More is kept.
- **Not freeing enough context** → raise it (0.6, 0.7).
- **Compaction never triggers** → lower `compactAtPercent`.
- **It falls back to the built-in summary** → the saving was under
  `minReductionRatio`; lower that, or accept that this session had little to drop.

## Calibrate on your own sessions

The shipped coefficients were fitted on one person's 18 sessions. A different
tool mix scores differently, so refitting is the expected thing to do, not an
advanced option:

```sh
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
sessions — the bar is the built-in scorer, not chance.

If the toast says `STATES TRUNCATED`, states are overflowing the checkpoint's
context and those scores were computed on fragments. Lower `maxCallStateTokens`
below the checkpoint's state budget (768 on multilingual, ~320 on english).

## Re-running the evaluation

```sh
bun eval/repeat.ts     # 10 grouped splits: mean, sd, worst case, paired wins
bun eval/baseline.ts   # cheap-feature baselines and a label-confound check
```

`eval/repeat.ts` is the number to trust. A single split flatters whatever it
measures — that mistake is recorded in the README, having been made here.
