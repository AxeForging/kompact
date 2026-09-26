# Changelog

## 0.1.0

First release. A fork of [tamaratran/fast-jev-compaction][a] and
[fatelei/jev-compact][b] that scores tool calls locally instead of through
TypeSafe's hosted Jev model.

[a]: https://github.com/tamaratran/fast-jev-compaction
[b]: https://github.com/fatelei/jev-compact

- **Per-call states.** Both upstreams send the whole conversation (up to 25,000
  tokens) as one state. The neural model's English checkpoint reads 512 tokens
  and discards the rest silently, so the state is now one small prose description per call,
  sized to the checkpoint's real budget and asserted in the suite.
- **A logistic scorer as the default**, over facts already computed for the
  state: no sidecar, no GPU, no network. Measured over 10 grouped splits of the
  1063 calls from 18 sessions every checkpoint was scored against, AUC
  0.905 ± 0.078 against 0.719 ± 0.026 for the best neural checkpoint and
  wording, winning 10 of 10 paired splits. With the shipped defaults the shipped
  code frees 33.6% of tool output and 8.7–32.4% of a real session's tokens,
  scoring 3,403 calls in 284 ms.
- **Fitted on 2239 calls from 41 sessions, and that is worse than it sounds.**
  Leave-one-session-out AUC is 0.789 with ECE 0.051, against 0.879 and 0.035 on
  18 of those same sessions. Widening the corpus within one person's own work
  cost nine points of AUC. Run `npm run calibrate`.
- **What a compaction costs the work**, measured rather than assumed
  (`eval/outcome.ts`): compacting where the engine would fire it, 6 of the 68
  outputs reused afterwards are dropped — 0.19 a session, with 27 of 32 sessions
  losing nothing.
- **No drop that frees less than it risks.** `minYieldChars` refuses to trade a
  real chance of losing content for thirty tokens.
  The 50–88% figure an earlier draft of this entry carried came from the
  threshold-only policy, which also dropped 74 of 78 outputs that were reused
  later; see `eval/RESULTS.md`.
- **A call that recorded a change is never dropped.** `Edit`, `Write`,
  `MultiEdit` and `NotebookEdit` keep their call whatever the scores say; only
  their output can go. The rule applies to 220 mutating calls in the corpus and
  re-running the same decisions without it shows what it saves: 15 of them would
  otherwise lose their call or their output, against the single output in those
  220 that was ever needed verbatim.

- **A result nothing can produce again is never dropped.** The mirror of the
  rule above: an `AskUserQuestion` result is somebody's answer and an
  `ExitPlanMode` result is the plan they approved, and re-running recovers
  neither. They are the two most-reused tools in the corpus — 47.1% and 83.3%
  of their outputs quoted verbatim later against an 11.0% base — and the scorer
  scores 17 of the 23 of them below the floor. The guard costs 0.1 of a point of
  freeing and takes retention from 77.7% to 79.4%.
- **The neural sidecar is gone from the product**, and stays in the evaluation.
  There is no option that turns it on, and `scorer` and `layaUrl` are gone from
  the documented options rather than read and ignored. What it cost is why:
  `eval/sidecar-bench.ts` reports 6.1 s to start, ~3.2 GB resident, ~5.8 GB of
  VRAM for the router and 4.9 s to score the sessions the built-in scorer scores
  in 281 ms — 17× the time for a lower AUC.

  That ratio is the second correction to this line, and the larger one. It read
  23.1 s and 122× until the projection was checked against an end-to-end run and
  found to be halving itself by dividing requests by the questions in one. It
  then read 90.7 s and **319×** for weeks, because the benchmark behind it was
  measured against a sidecar pinned to `LAYA_DEVICE=cpu` while the card sat
  idle — printed, unread, two lines above its own table as `gpu: … 148 MiB`. On
  the GPU the same work takes 4.9 s. The conclusion is unchanged and the
  magnitude was wrong by a factor of eighteen; the benchmark now refuses to
  print publishable rows from a CPU sidecar.

- **Compaction defers the model summary instead of replacing it once.**
  `minReductionRatio` is gone. A pass is taken when it reclaims at least
  `minFreedPercent` (5) percentage points of the context window, and
  `maxPasses` (6) is the backstop. The old bar asked whether a pass was a large
  fraction of the transcript and, replayed over the production loop on real
  sessions (`eval/passes.ts`), took 0 of 14 passes: every compaction went to the
  model summary while this could still free nine points of window in under
  20 ms. Sharing a unit with `compactAtPercent` makes the rule its own
  hysteresis band. **Not verified:** what deferring the summary costs.

- **A cap on kept results**, `maxKeptChars` (24,000). Half of all tool output
  lives in about 3% of the calls, so shortening the 27 longest of 2,239 frees
  20.7% of the corpus for 6.2% of the characters later steps quoted back.
  16,000 frees more and costs more; a cap graded by the scorer's confidence was
  measured and is worse than a flat one at every setting.

- **Token accounting is a division, not a pass.** The yield rule is denominated
  in tokens; counting them per message cost 143 ms a pass on a 7,300-message
  session, twice per compaction. One measured ratio (2.946 characters per token
  over the twelve largest transcripts here) replaces it, and a test fails if the
  counting comes back.
- **Local calibration.** `npm run calibrate` refits on your own transcripts and
  emits `KOMPACT_WEIGHTS`; the shipped coefficients come from one person's
  sessions and should not be assumed to transfer.
- **A System One server** (`npm run serve`) so existing clients — `jev-compact`
  for Codex CLI among them — work by repointing one URL.
- **Every number is generated.** `npm run eval:results` writes `eval/RESULTS.md`
  from the scripts themselves, `docs/eval.html` is rendered from it, and
  `test/published-figures.test.ts` fails if the README, the page, the manifest or
  a source comment disagrees. This exists because hand-transcribed figures drifted
  three times, the last of which turned out to be a genuine defect: one
  `tool_use_id` appears in two sessions and the eval scripts cached features
  keyed by it alone.
- **A committed corpus.** `eval/labels.jsonl` cannot be published — it holds
  verbatim tool output — so `npm run eval:fixtures` derives a scrubbed copy that
  produces a bit-identical feature matrix, plus two session fixtures that let the
  orphaned-`tool_use` test run in CI instead of skipping.
- Claude Code plugin replacing compaction via `session.compact`, falling back to
  the built-in summary on any failure.
