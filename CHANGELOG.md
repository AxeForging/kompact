# Changelog

## 0.1.0

First release. A fork of [tamaratran/fast-jev-compaction][a] and
[fatelei/jev-compact][b] that scores tool calls locally instead of through
TypeSafe's hosted Jev model.

[a]: https://github.com/tamaratran/fast-jev-compaction
[b]: https://github.com/fatelei/jev-compact

- **Per-call states.** Both upstreams send the whole conversation (up to 25,000
  tokens) as one state. Laya's English checkpoint reads 512 tokens and discards
  the rest silently, so the state is now one small prose description per call,
  sized to the checkpoint's real budget and asserted in the suite.
- **A logistic scorer as the default**, over facts already computed for the
  state: no sidecar, no GPU, no network. Measured over 10 grouped splits of the
  1063 calls from 18 sessions every checkpoint was scored against, AUC
  0.905 ± 0.078 against 0.719 ± 0.026 for the best Laya checkpoint and wording,
  winning 10 of 10 paired splits. With the shipped defaults it frees 23.4% of
  droppable tool output and 13–32% of a real session's tokens, scoring ~1,500
  calls in ~160 ms.
- **Fitted on 2239 calls from 41 sessions, and that is worse than it sounds.**
  Leave-one-session-out AUC is 0.789 with ECE 0.051, against 0.862 and 0.019 on
  18 of those same sessions. Widening the corpus within one person's own work
  cost seven points of AUC. Run `npm run calibrate`.
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
  their output can go. Rescues 21 of the 138 mutating calls in the corpus and
  costs nothing: reused-output retention is unchanged at 84.6%.
- **Laya stays available** behind the same `Asker` seam for anyone with a
  checkpoint fine-tuned on their own sessions, and is now measurable rather than
  only comparable: `eval/laya-bench.ts` reports 7.1 s to start, ~4.9 GB resident,
  ~5.0 GB of VRAM, and 21.5 s to score a session the built-in scorer scores in
  164 ms.
- **Local calibration.** `npm run calibrate` refits on your own transcripts and
  emits `LAYA_COMPACT_WEIGHTS`; the shipped coefficients come from one person's
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
