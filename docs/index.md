# kompact — context compaction you can check

**It keeps the file, not a summary of it.**

Claude Code compacts by asking a model to summarise your session, and the exact
wording goes with it. kompact scores every tool call instead and drops only what
is no longer needed verbatim — locally, with no API key, no GPU, no network call.

## At a glance (measured on real sessions)
- **~29% of tokens freed** on real sessions.
- **0.789** ranking quality (result-needed AUC, leave-one-session-out over 41 sessions).
- **~281 ms** to score 3,591 tool calls.
- **0** network calls, ever.

On the paired corpus (1063 calls, 10 grouped splits): AUC **0.905 ± 0.078**,
worst split **0.684**, ECE **0.019**. An "output size alone" baseline reaches
AUC **0.876** — most of the signal is one feature, and a neural sidecar (Laya)
tried and lost at AUC **0.721**. Every number here carries its uncertainty, and
negative results are given equal weight; see [/evidence.html](/evidence.html)
and [/eval.html](/eval.html).

## What is never dropped
Two things are kept whatever they score: a call that **changed something**
(Edit/Write and the like), and an **answer you gave it** — an `AskUserQuestion`
result or an approved plan — because asking again is a new question. kompact
hands back to Claude Code's own summary rather than to a half-compacted transcript.

## Install
```
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude plugin marketplace add AxeForging/kompact
claude plugin install kompact
```

## More
- [Evidence](/evidence.html) — measured results with uncertainty.
- [Evaluation](/eval.html) — methods, corpus, and every study.
- [Trigger](/trigger.html) — when compaction runs.
- [Glossary](/glossary.html) — terms.
- Source: https://github.com/AxeForging/kompact (MIT).
