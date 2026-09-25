# laya-compact

Context compaction that scores every tool call before it compacts, keeps what is
still needed verbatim, and drops the rest. Local, offline, no API key.

**[The measurements, presented →](https://axeforging.github.io/laya-compact/)**

A fork of [tamaratran/fast-jev-compaction][up1] (Claude Code) and
[fatelei/jev-compact][up2] (Codex CLI), which do the same thing with TypeSafe's
hosted **Jev** model. This one does not send your session to anyone.

[up1]: https://github.com/tamaratran/fast-jev-compaction
[up2]: https://github.com/fatelei/jev-compact

## What changed, and why

The port started out as "point the client at a local [Laya][laya] sidecar
instead of Jev". Laya speaks Jev's wire protocol, so that part really is a
one-line change. Measuring it is what took the work, and the measurements
changed the design twice.

[laya]: https://github.com/NandhaKishorM/laya

### 1. One big state does not survive the swap

Both upstreams send the **entire conversation** — up to 25,000 tokens — as the
state with every request, and point the questions at calls inside it. Jev reads
32k. Laya's English checkpoint reads **512 tokens in total**, ~320 of them
state; multilingual reads 1024.

Over-long states are **truncated silently**: HTTP 200, no warning, a score
computed from the first few percent. Measured on a state padded with irrelevant
filler around one decisive sentence:

| state | chars | tokens read | answer |
|---|---|---|---|
| the sentence alone | 78 | 48 | 0.611 |
| sentence + filler | 4,278 | 512 | 0.4113 |
| sentence + filler | 21,078 | **512** | **0.4113** |

The 4k and 21k rows are bit-identical. Diluted, the English checkpoint answered
**0.41 — below any sane threshold — for a fact the state stated verbatim**.

So the state is inverted: **one small prose state per tool call**, sized to the
checkpoint's real budget and asserted in the test suite. Every number is turned
into words first (`describeSize`, `describeAge`) because Laya cannot read
digits — its own docs record that no checkpoint could tell which of two
altitudes was lower.

### 2. The decision model loses to a logistic regression

With that fixed, 1063 tool calls from 18 real sessions were labelled — no
hand-labelling and no teacher model. The signal is behavioural: if the assistant
later reproduced a distinctive run of eight words from an output, in its prose or
inside a later tool input such as an `Edit`'s `old_string`, that output was
needed verbatim. If it simply read the same target again, the output was
reproducible by definition.

Then every checkpoint and question wording was scored against those labels.
**Not once** — a single split flatters whatever it measures, and this was caught
happening: on an earlier 721-call corpus the built-in scorer looked like 0.918
and Laya's best like 0.694, and both moved once the corpus grew. The numbers
below are the mean over **10 grouped splits**, each holding out 30% of sessions,
with every scorer judged on the same split so the comparison is paired
(`eval/repeat.ts`). Every figure below is transcribed from `eval/RESULTS.md`,
which `npm run eval:results` regenerates:

| scorer | AUC (mean ± sd) | worst split | chars freed at 90% safety |
|---|---|---|---|
| **built-in logistic, 13 features** | **0.895 ± 0.073** | 0.688 | **38.8%** |
| output size alone | 0.876 ± 0.011 | 0.855 | 11.4% |
| laya typed-decisions, "direct" | 0.721 ± 0.021 | 0.686 | 12.1% |
| laya multilingual, "direct" | 0.667 ± 0.022 | 0.644 | 4.5% |
| laya english, "entailment" | 0.628 ± 0.015 | 0.610 | 18.0% |
| laya typed-decisions, "reproducible" | 0.419 ± 0.024 | 0.393 | 8.2% |
| keep everything | 0.500 | — | 0.0% |

AUC 0.5 is a coin flip. The logistic beat the best Laya config on **10 of 10
splits**, by +0.174 on average — but by as little as **+0.002** on the closest
one, so the margin is not uniform. Leave-one-session-out over all 18 sessions
puts it at AUC 0.862 with ECE 0.019, an order of magnitude better calibrated
than Laya's 0.42-0.71, which is what makes `keepThreshold` mean anything.

Note also that **output size alone** scores 0.876 with a quarter of the
variance. Most of the signal is "big outputs get reused"; the other twelve
features earn their place on the product metric (39% of characters freed against
11%), not on ranking.

This is not a criticism of Laya. Its own README says the base checkpoints score
near chance on typed-decision workflows and that it should be treated as a fast
base to specialise, not a zero-shot decision engine. That is exactly what was
measured. **A fine-tuned checkpoint now has to beat 0.895, not 0.5** — so
fine-tuning was not done, and `eval/` is set up to re-run the comparison for
anyone who tries.

So the default scorer is the logistic model, and Laya stays a drop-in behind the
same `Asker` seam.

## Install (Claude Code)

Function hooks are early access and must be enabled:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1

claude plugin marketplace add AxeForging/laya-compact
claude plugin install laya-compact@laya-compact
```

For local development, point at a checkout instead:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

The plugin ships one skill, `laya-compact`, covering how to read its decision
log, choose a threshold, calibrate, and diagnose a compaction that kept or
dropped the wrong thing. What it costs every session is its 80-word
description; the 3 KB body loads only when the skill is invoked.

Claude Code's `session.compact` hook returns a replacement message list, so the
plugin *replaces* compaction rather than repairing it: user and assistant text is
never touched, only tool calls and tool results are dropped or truncated.

The type declarations in `types/` were written by Claude Code 2.1.281.
**Regenerate them with `/plugin-types` after upgrading**, then run
`npm run typecheck`.

## Configuration

| Option | Default | Meaning |
|---|---:|---|
| `scorer` | `features` | `features` (offline, AUC 0.895) or `laya` (a sidecar) |
| `layaUrl` | `http://127.0.0.1:8000/v1/systemone` | only read when `scorer` is `laya` |
| `keepThreshold` | `0.1` | a **floor**: at or above this, never dropped |
| `targetReduction` | `0.5` | fraction of droppable tool output to free |
| `preserveRecentMessages` | `6` | newest messages pinned; the first is always kept |
| `compactAtPercent` | `60` | context percentage that triggers compaction |
| `minReductionRatio` | `0.25` | below this saving, delegate to the built-in summary |
| `truncateHeadChars` | `300` | head kept of a dropped result |
| `maxCallStateTokens` | `700` | `scorer=laya` only; must stay under the checkpoint's budget |

A dropped result is **not deleted**: its first `truncateHeadChars` characters
survive with a note, and the assistant can re-run the tool. That is why 90%
safety is a defensible setting: a miss costs a re-run, not the work.

**Why a floor and a budget, not a threshold.** The scorer produces a ranking,
and that ranking generalises across sessions. An absolute probability cut does
not, because each session has its own mix of tools and so its own distribution:
a Bash-heavy session scores low throughout and a fixed cut sweeps all of it.
Calls are therefore dropped lowest-score-first only until `targetReduction` is
met, with `keepThreshold` as a floor nothing is dropped above. Simulated per
session on the labelled corpus (`eval/policy.ts`):

| policy | tool output freed | reused outputs kept | reused chars kept |
|---|---|---|---|
| absolute cut at 0.5 (an earlier default) | 97.6% | **5.1%** | 8.5% |
| **budget 0.5, floor 0.1 (shipped)** | 42.4% | **84.6%** | **87.5%** |
| budget 0.7, floor 0.1 | 52.9% | 82.1% | 79.2% |
| budget 0.7, floor 0.05 | 8.6% | 92.3% | 98.9% |

Run through the shipped code rather than the simulation above, the same defaults
give **43.0% freed and 84.6% of reused outputs kept** — the small difference is
the one rule the sweep has no notion of, below.

Freeing nearly everything is easy and nearly worthless. This is why `calibrate`
is an accuracy upgrade rather than a prerequisite: the policy adapts to your
distribution without it.

### One rule the scorer does not get a vote on

An `Edit`, `Write`, `MultiEdit` or `NotebookEdit` call is never dropped. Its
*result* can be — "Applied 1 edit to src/auth.ts" is worth nothing, and exactly
1 of the 138 mutating calls in the corpus had an output that was ever needed
verbatim — but its *input* is the only record that the change happened, and
unlike a read it cannot be recovered by running it again.

This came out of the demonstration on the page: with the scorer left to itself,
it dropped the `Edit` that fixed the bug the session was about, because the
output was worthless and the file was not read again afterwards. Across the
corpus the rule rescues **21 of 138** such calls and costs nothing — reused-output
retention is unchanged at 84.6%, and freed rises from 42.9% to 43.0%, because the
budget then continues down the ranking.

### What the other 15.4% costs

"84.6% of reused outputs kept" invites you to supply your own answer for the
rest, so `eval/recovery.ts` prices it. Held-out scores, shipped policy, per
session: **10 of the 78 reused outputs are dropped and actually shortened** —
0.56 per session. Two more are "dropped" but short enough to fit inside the
retained head, so nothing is removed at all.

None of the ten kept a head, because both their scores were low enough to drop
the call outright. **Nine of the ten are `Bash` output reused verbatim in a later
tool input.** That is the shape this scorer is worst at: `tool=Bash` carries a
-1.36 coefficient because most command output is never referred to again, and the
minority that is gets swept with it. One was a `Read` of an unchanged file, which
re-reading recovers exactly.

**This is recovery cost, not task outcome.** Nothing here shows an assistant
given the compacted transcript still finishing the job — that needs a live A/B
and is listed as unverified below. The figure also over-counts: a reuse that had
already happened by the time a real compaction fired costs nothing when the
output is dropped now.

Any failure at all — scorer down, malformed response, saving below
`minReductionRatio` — falls back to Claude Code's built-in compaction. A single
failed request keeps its call: a wrong keep costs context, a wrong drop destroys
something unrecoverable.

## Using Laya instead

```sh
uv tool install "laya[serve]"
LAYA_HOST=127.0.0.1 LAYA_DEVICE=cuda LAYA_PRELOAD=1 LAYA_MODELS=multilingual laya-serve
```

`LAYA_HOST` defaults to `0.0.0.0`; set it explicitly. Then set `scorer` to
`laya`. Expect it to be worse until you fine-tune on your own sessions — and
watch for `STATES TRUNCATED` in the compaction toast, which means states are
overflowing the checkpoint and the scores are being computed on fragments.

`phrasing` is worth setting if you do: on `typed-decisions`, `direct` scores AUC
0.721 and `reproducible` 0.419, so the wording matters more than the checkpoint.

### What it costs to run

Measured on one machine, RTX 4060 Laptop, one `laya-serve` process
(`eval/laya-bench.ts`, which needs the sidecar live):

| | |
|---|---|
| cold start to first answer | **7.6 s** |
| resident memory | **3.1 GB** at first answer, **4.9 GB** warm |
| VRAM | **~5.0 GB** |
| latency, `multilingual`, 8 questions | **735 ms** median |
| latency, `english` / `typed-decisions`, 8 questions | 1,820 ms / 1,943 ms |

`laya-serve` loads every checkpoint at startup and routes per request, so memory
and start-up are properties of the router, not of the checkpoint you pick. Only
latency is per checkpoint.

Scoring one real session — 1,071 calls, two questions a request, eight in flight
— takes **14.5 s on the fastest checkpoint against 108 ms for the built-in
scorer**, holding ~5 GB the whole time. That is 134x the time for a lower AUC,
which is the arithmetic behind the default. Fine-tuning changes the AUC; it does
not change this table.

## Calibrate it on your own sessions

**The shipped coefficients were fitted on one person's 18 sessions.** Someone
whose work is mostly `Bash`, or mostly web research, or who works in a language
the labeller's eight-word shingles do not match, has a different distribution.
Nothing here detects that for you, so refitting is the expected step, not an
advanced one:

```sh
npm run calibrate           # extract labels, then compare shipped vs refit
bun eval/calibrate.ts --write
```

It labels your own `~/.claude/projects` transcripts behaviourally — nothing is
sent anywhere — reports shipped against refit held out by session, and emits a
`LAYA_COMPACT_WEIGHTS` value for the `env` block of `~/.claude/settings.json`.
It refuses to fit on fewer than 3 sessions or 20 positives, which is too thin to
mean anything.

Read the delta before adopting it. On the machine the shipped weights were
fitted on, their column is in-sample and will flatter itself; for anyone else
the comparison is fair.

## Codex CLI, and anything else that speaks the protocol

The scorer is also served on Jev's wire protocol, so an existing Jev client
works against it by repointing one URL — no second plugin to write:

```sh
npm run serve        # http://127.0.0.1:8770/v1/systemone, no model, no GPU
```

For Codex CLI, install [fatelei/jev-compact][up2] and put this in
`~/.codex/fast-jev-compaction.json`:

```json
{ "baseUrl": "http://127.0.0.1:8770/v1/systemone", "apiKey": "unused" }
```

`apiKey` is only there because that plugin refuses to start without one; the
server ignores it unless started with `--api-key`.

**Not verified against a live Codex.** That plugin needs Codex >= 0.155 and this
was built on 0.131, so the protocol side is covered by tests and curl but the
Codex integration itself is not. The Claude Code path is the one that has run.

## Reproducing the numbers

```sh
bun eval/extract-labels.ts      # labels from ~/.claude/projects/**/*.jsonl
bun eval/score.ts --port 8001   # score every checkpoint x phrasing (needs laya-serve)
bun eval/repeat.ts              # 10 grouped splits: mean, sd, worst case, paired wins
bun eval/baseline.ts            # cheap-feature baselines, plus a label-confound check
bun eval/fit.ts                 # refit the shipped coefficients, print LOSO AUC
```

`eval/repeat.ts` is the one to trust. Subagent transcripts count as their own
sessions; they are entirely sidechain rows, and dropping sidechains
unconditionally threw those files away whole.

The corpus is whatever sessions are on the machine, so absolute numbers will
differ. The comparison is what matters, and `eval/baseline.ts` prints it.

## What is verified, and how

Being precise about this, because "it compiles" is not evidence.

| Claim | How |
|---|---|
| Scoring beats the model it replaces | 1063 labelled calls, 18 sessions, 10 grouped splits: AUC 0.895 ± 0.073 vs 0.721 ± 0.021, winning 10/10 paired splits (`eval/repeat.ts`, transcribed into `eval/RESULTS.md`) |
| States never overflow the checkpoint | asserted for outputs from 0 to 2,000,000 chars |
| No orphaned `tool_use`/`tool_result` survives | the hook run over a **real** session from disk; an orphan is rejected by the API and would break the session compaction was meant to save |
| User and assistant prose is never touched | same real-session test |
| A dead sidecar never breaks a session | falls back to the built-in summary; asserted |
| One failed request never deletes anything | that call is kept; asserted |
| The Codex plugin works against the server | `jev-compact`'s own parser, pairing, scorer and HTTP client, driven over its recorded Codex rollout fixture, produce discriminating scores |
| The plugin loads in a real engine | `claude --plugin-dir .` with function hooks on |
| `turn.complete` fires and requests compaction | verified live: the hook was invoked in a real session, `$.session.usage()` returned a real percentage, and `$.session.compact()` was called |

**Not verified:** the engine invoking `session.compact` *in a live session* and
accepting the replacement message list. Forcing it needs genuine context
pressure — at 5-31% full the engine correctly declines to compact, and `/compact`
is a CLI command the model cannot invoke. Everything that handler does is covered
by the real-session test above; what is untested is the engine-side handoff,
which is the same API the upstream uses. To close it: open a session with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`, work until the
context bar is well along, then type `/compact` — the toast reports the reduction
and every decision lands in the log.

Also unverified: **task outcome**. Every metric here is tokens, ranking or
recovery cost; none is whether the assistant still finishes. Closing it needs the
same session replayed with and without compaction and the tool calls compared,
which is the next thing worth building.

And a live Codex CLI, which needs >= 0.155 (this machine has 0.131).

## Development

```sh
bun install
npm run typecheck   # src + test + eval + hooks
npm run test        # 72 tests
npm run validate    # plugin manifest
```

The Codex interop test needs both upstreams checked out under `vendor/`; without
them it skips rather than fails. CI clones them and asserts it ran. See
[CONTRIBUTING.md](CONTRIBUTING.md) — in particular, re-run `eval/repeat.ts` and
quote mean, sd and worst split if you touch the scorer.

`vendor/` holds both upstreams, unmodified, so their fixes stay diffable. The
`Jev*` type names are kept for the same reason; the model behind them is not Jev.

## License

MIT, as both upstreams. Laya is Apache-2.0.
