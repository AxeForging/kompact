# Contributing

## Before changing the scorer

The coefficients in `src/features.ts` are a measurement, not a preference. If
you change the features, the state prose or the labelling rule, re-run the
evaluation and put the new numbers in the same places:

```sh
bun eval/extract-labels.ts   # labels from your own ~/.claude/projects
bun eval/repeat.ts           # 10 grouped splits — the number to trust
bun eval/fit.ts              # refit; paste the coefficients into src/features.ts
```

Quote `eval/repeat.ts` (mean, sd, worst split), never a single split. A single
split flatters whatever it measures: an earlier draft of this project reported
AUC 0.918 that way and it was 0.895 ± 0.073 once repeated. Regenerate
`eval/RESULTS.md` with `npm run eval:results` rather than transcribing a figure
into prose; `test/published-figures.test.ts` then fails if the README, the page,
the manifest or a source comment disagrees with it.

Two corpora, one of which is committed. `eval/labels.jsonl` is derived from your
own sessions and is gitignored — it holds verbatim tool output and, in at least
one row, an email address. `npm run eval:fixtures` derives the committed
`eval/fixtures/labels.jsonl` from it, replacing the task line, the target and the
output excerpt; `eval/make-fixture.ts` asserts the two produce a bit-identical
feature matrix, so `npm run eval:ci` on a runner reports the same AUC this
machine does. The same command derives `test/fixtures/session.jsonl` and
`subagent.jsonl`, which is what makes `test/real-transcript.test.ts` run in CI
instead of skipping.

If you add a feature, it has to earn its place against `output size alone`,
which already scores AUC 0.876 on its own.

## Before changing compaction

`applyDecisions` must never leave an orphaned `tool_use` or `tool_result`. The
API rejects those, which breaks the session the compaction was meant to save.
`test/real-transcript.test.ts` asserts it against a real session on disk; keep
that test passing and do not weaken it into a fixture.

Failures must fail safe: a scorer that is down, a malformed response, or a
saving below `minReductionRatio` all fall back to the host's built-in
compaction, and a single failed request keeps its call. A wrong keep costs
context; a wrong drop costs work that cannot be recovered.

## Checks

```sh
bun install
npm run typecheck   # src + test + eval + hooks
npm run test
npm run validate    # plugin manifest
```

The Codex interop test needs the upstreams present:

```sh
git clone --depth 1 https://github.com/tamaratran/fast-jev-compaction.git vendor/fast-jev-compaction
git clone --depth 1 https://github.com/fatelei/jev-compact.git vendor/jev-compact
```

Without them it skips rather than fails, so check it actually ran.

## Do not commit

`eval/labels.jsonl` and `eval/scores.json` are derived from real sessions and
contain verbatim excerpts of tool output. They are gitignored; keep it that way.
