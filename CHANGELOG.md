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
  state: no sidecar, no GPU, no network. Measured over 10 grouped splits of 1063
  calls from 18 real sessions, AUC 0.895 ± 0.073 against 0.721 for the best Laya
  checkpoint and wording, winning 10 of 10 paired splits. Frees 50–88% of tool
  output on real sessions in 6–52 ms.
- **Laya stays available** behind the same `Asker` seam for anyone with a
  checkpoint fine-tuned on their own sessions.
- **Local calibration.** `npm run calibrate` refits on your own transcripts and
  emits `LAYA_COMPACT_WEIGHTS`; the shipped coefficients come from one person's
  sessions and should not be assumed to transfer.
- **A System One server** (`npm run serve`) so existing clients — `jev-compact`
  for Codex CLI among them — work by repointing one URL.
- Claude Code plugin replacing compaction via `session.compact`, falling back to
  the built-in summary on any failure.
