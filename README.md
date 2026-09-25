# kompact

Context compaction that scores every tool call before it compacts, keeps what is
still needed verbatim, and drops the rest. Local, offline, no API key.

**[The measurements, presented →](https://axeforging.github.io/kompact/)**

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
computed from the first 512 tokens. `npm run eval:truncation` asks one question
— *the text says the deployment was rolled back* — of four states. All four
state the fact verbatim; only where the sentence sits changes.

| state | chars | tokens read | answer |
|---|---|---|---|
| the sentence alone | 85 | 47 | 0.8472 |
| first, plus filler | 8,140 | **512** | **0.9152** |
| first, plus 5× filler | 40,360 | **512** | **0.9152** |
| last, after 5× filler | 40,360 | 512 | **0.2191** |

Rows two and three are bit-identical: **32,220 characters were discarded** and
nothing in the response says so. Row four is what that costs — the same 40,360
characters and the same sentence, moved past the cut, and the answer falls from
0.9152 to **0.2191 for a fact the text still states verbatim**. A caller cannot
tell rows three and four apart: same 200, same shape, same silence.

So the state is inverted: **one small prose state per tool call**, sized to the
checkpoint's real budget and asserted in the test suite. Every number is turned
into words first (`describeSize`, `describeAge`) because Laya cannot read
digits — its own docs record that no checkpoint could tell which of two
altitudes was lower.

### 1b. The checkpoint named for English is not the best at English

The obvious move once the 512-token limit bites is to reach for the multilingual
checkpoint, which reads 1024. Measured on the same 1,063 calls and the same ten
grouped splits, it is the better checkpoint for English work anyway — and the
English one has no configuration in which it is the right choice:

| checkpoint | direct | entailment | reproducible | context |
|---|---|---|---|---|
| multilingual | **0.667 ± 0.023** | 0.604 ± 0.015 | 0.610 ± 0.016 | 1024 |
| english | **0.480 ± 0.012** | 0.625 ± 0.016 | 0.539 ± 0.016 | 512 |

On the strongest wording the gap is **0.187 AUC and the ranges do not overlap** —
english tops out at 0.502, multilingual bottoms out at 0.638 — and 0.480 is below
a coin flip. English wins only on `entailment`, by 0.021, which is inside one
standard deviation. Its best config, 0.625, still loses to multilingual's best,
0.667. It is also about **3× slower**: 381 ms against 123 ms for one question,
1,704 ms against 573 ms for eight (`eval/RESULTS.md`).

Half the context, worse on the wording that works, and three times the latency.
None of which rescues the sidecar: `typed-decisions` reads 1024 too and scores
**0.719**, and the built-in logistic scores 0.905 with no GPU at all.

**This does not affect the shipped default**, because the states are not large
enough for any of it to bind: across all 2,239 calls in the corpus they run 35 to
**97 tokens**, against a 768-token budget. The 512-token cliff is a property of
sending the whole conversation, which is the upstream design this one replaced.

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
which `npm run eval:results` regenerates and
[the evaluation page](https://axeforging.github.io/kompact/eval.html) publishes:

| scorer | AUC (mean ± sd) | worst split | chars freed at 90% safety |
|---|---|---|---|
| **built-in logistic, 12 fitted features** | **0.905 ± 0.078** | 0.684 | **35.4%** |
| output size alone | 0.878 ± 0.010 | 0.855 | 11.9% |
| laya typed-decisions, "direct" | 0.719 ± 0.026 | 0.666 | 12.1% |
| laya multilingual, "direct" | 0.667 ± 0.023 | 0.638 | 4.5% |
| laya english, "entailment" | 0.625 ± 0.016 | 0.602 | 18.0% |
| laya typed-decisions, "reproducible" | 0.419 ± 0.025 | 0.393 | 8.2% |
| keep everything | 0.500 | — | 0.0% |

AUC 0.5 is a coin flip. The logistic beat the best Laya config on **10 of 10
splits**, by +0.186 on average and by **+0.018** on the closest one.

That table is the **paired** corpus: 1,063 calls from the 18 sessions every
checkpoint and wording was scored against. The shipped coefficients are fitted on
all 2,239 labelled calls from 41 sessions, and that is where the uncomfortable
number lives. **Leave-one-session-out over 41 sessions gives AUC 0.789 with ECE
0.051** — against 0.879 and 0.035 on the 18 paired sessions, which
`bun eval/fit.ts --fixture --paired` reproduces. Widening the
corpus *within one person's own work* cost nine points of AUC and half again
the calibration error. That is the most direct evidence available that these
coefficients do not transfer as far as one number suggests, and the reason
`npm run calibrate` is not politeness. The clearest single case:
`targetReadAgain` was +0.03 on the narrow corpus and is **−0.59** here, because
with more sessions "the assistant read this again later" turns out to mean the
output was reproducible.

Note also that **output size alone** scores 0.878 with a quarter of the
variance. Most of the signal is "big outputs get reused"; the other features
earn their place on the product metric (35% of characters freed against 12%),
not on ranking.

And one of the thirteen was never fitted. **The corpus contains no `Grep` and no
`Glob` call**, so that feature never fired and its coefficient is `0.0` — zero by
absence, not by measurement. A search scores at the reference level, alongside
`WebFetch` and `Agent`, about which this scorer also knows nothing. If your work
is search-heavy, `npm run calibrate` is not optional politeness.

This is not a criticism of Laya. Its own README says the base checkpoints score
near chance on typed-decision workflows and that it should be treated as a fast
base to specialise, not a zero-shot decision engine. That is exactly what was
measured. **A fine-tuned checkpoint now has to beat 0.905, not 0.5** — so
fine-tuning was not done, and `eval/` is set up to re-run the comparison for
anyone who tries.

So the default scorer is the logistic model, and Laya stays a drop-in behind the
same `Asker` seam.

## Install (Claude Code)

Function hooks are early access and must be enabled:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1

claude plugin marketplace add AxeForging/kompact
claude plugin install kompact@kompact
```

For local development, point at a checkout instead:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

The plugin ships one skill, `kompact`, covering how to read its decision
log, choose a threshold, calibrate, and diagnose a compaction that kept or
dropped the wrong thing. What it costs every session is its 80-word
description; the 6 KB body loads only when the skill is invoked.

Claude Code's `session.compact` hook returns a replacement message list, so the
plugin *replaces* compaction rather than repairing it: user and assistant text is
never touched, only tool calls and tool results are dropped or truncated.

The type declarations in `types/` were written by Claude Code 2.1.281.
**Regenerate them with `/plugin-types` after upgrading**, then run
`npm run typecheck`.

## Configuration

| Option | Default | Meaning |
|---|---:|---|
| `scorer` | `features` | `features` (offline, AUC 0.905) or `laya` (a sidecar) |
| `layaUrl` | `http://127.0.0.1:8000/v1/systemone` | only read when `scorer` is `laya` |
| `keepThreshold` | `0.2` | a **floor**: at or above this, never dropped |
| `targetReduction` | `0.5` | fraction of droppable tool output to free |
| `preserveRecentMessages` | `6` | newest messages pinned; the first is always kept |
| `compactAtPercent` | `60` | context percentage that triggers compaction |
| `minFreedPercent` | `5` | a pass is taken only if it reclaims this many percentage points of the context window; below it, the built-in summary runs |
| `maxPasses` | `4` | compactions kompact answers on one transcript before handing over regardless |
| `truncateHeadChars` | `300` | head kept of a dropped result |
| `maxCallStateTokens` | `700` | `scorer=laya` only; must stay under the checkpoint's budget |
| `minYieldChars` | `200` | fewest characters a drop must free to be worth making |
| `maxKeptChars` | `24000` | longest a **kept** result may be; `0` disables |
| `phrasing` | `reproducible` | `scorer=laya` only; `direct` or `entailment` |
| `concurrency` | `8` | requests in flight; `scorer=laya` only in practice |
| `requestTimeoutMs` | `30000` | deadline for one sidecar request |

Two of these do nothing under the default scorer and say so in the manifest:
`maxCallStateTokens` sizes a state only a model reads, and `phrasing` changes
wording the built-in scorer never looks at.

A call is also never dropped when doing so would free less than `minYieldChars`.
Dropping an 89-character `Grep` result freed 126 characters — about thirty tokens
— for a real chance of losing something the session went on to need; below the
floor the ranking is not worth acting on however confident it is.

A dropped result is **not deleted**: its first `truncateHeadChars` characters
survive with a note, and the assistant can re-run the tool. That is why 90%
safety is a defensible setting: a miss costs a re-run, not the work.

### It runs more than once before the model summary does

One compaction is the mechanism; the loop is the product. The engine asks at
`compactAtPercent`, kompact answers, you keep working, and it asks again. The
question is when to stop answering and let the engine write its summary instead.

Until this version the rule was `minReductionRatio: 0.25` — take the pass if it
removed a quarter of the transcript. `bun eval/passes.ts` replays the real loop
on real sessions, giving each pass the compacted prefix *plus the real
continuation* rather than its own output, and that bar took **0 of 14** passes.
Every one of them went to the model summary while kompact could still free nine
points of context window in under 20 ms.

The unit was the mistake. A quarter of a 7,000-message session and a quarter of
a 200-message one are not the same amount of room to keep working in, and room
is what runs out. `minFreedPercent` is denominated in percentage points of the
context window, which is comparable between them and is the same unit as
`compactAtPercent`:

| bar | passes taken, of 14 |
|---|---|
| `minReductionRatio` 0.25 *(old default)* | **0** |
| `minReductionRatio` 0.08 | 11 |
| **`minFreedPercent` 5** *(shipped)* | **10** |
| `minFreedPercent` 10 | 1 |

Sharing a unit with the trigger makes the rule its own guard. A pass that is
taken leaves the session at least `minFreedPercent` below `compactAtPercent`, so
it has to grow back through that band before another compaction can be
requested — compacting on every turn is not possible rather than discouraged.
A two-turn cooldown covers the rest, because `$.session.usage()` reports the
tokens the *last response* was answered over and is stale for a turn after a
compaction.

`maxPasses: 6` is a backstop, and on the largest session measured it is the
thing that stops the loop: raised to 8 that session runs 9.0 9.4 8.6 8.3 7.5
6.6 6.7 5.3 and stops on the floor at the ninth, and at 12 it stops in the same
place. Six is therefore not where the loop runs out — it is where this hands
over anyway, because what deferring the summary costs is not measured and a
backstop whose value is a judgement should be the conservative one.

**The extra passes are not free**, and `bun eval/outcome.ts --passes 6` prices
them. Replayed over 32 sessions, the loop drops 21 outputs a later step went
back to, against 6 for a single pass — **3.5× the loss for 1.38× the
characters**. The first pass is the efficient one and that is structural: it
compacts the whole accumulated backlog at once, at 0.058 lost outputs per 10,000
characters freed, where every pass after it works on fresh material only and
pays 0.33 to 0.67. That is not an argument for stopping at one — the alternative
to pass two is the model summary, which keeps no tool output verbatim at all —
but `maxPasses: 1` buys the cheap pass and nothing else.

**Not verified:** what deferring the summary costs. `applyDecisions` never
touches prose, so what survives six passes is verbatim tool calls and the
session's own words — which is a different thing from a narrative about them.
Nothing here has measured whether an assistant misses it.

### The cap on what is kept

The ranking decides *which* outputs to drop. It never had an opinion about how
much of the ones it keeps is worth carrying, and that turns out to be where the
characters are. Over 72 sessions and 5,945 calls on one machine, **half of all
tool output lives in about 3% of the calls**. Like `eval/sessions.ts`, this reads
whatever `~/.claude/projects` holds, so the corpus size here is a snapshot that
grows as you work; the shape it reports has not moved.

`bun eval/where-reused.ts` asks where inside a reused output the reuse actually
falls, by giving every 8-word shingle its character offset and finding which
ones later text quotes. Reuse is spread through the output, not gathered at the
front: median depth **0.46** of the way in, only **9%** of quoted passages
inside the first tenth. A tail window does not help either — head-and-tail
measured slightly *worse* than a plain head at every budget, so that idea is
dead and this is where it is buried.

A cap is worth having anyway, because of the size distribution rather than the
position of the reuse. `bun eval/cap.ts` scores both levers on one corpus by one
measure, the share of later-quoted passages still present afterwards:

| policy | freed | quoted passages kept |
| --- | --- | --- |
| ranking only (shipped before this) | 23.1% | 81.6% |
| ranking + cap 24,000 | **25.5%** | 81.5% |
| ranking + cap 16,000 | 29.4% | 80.8% |
| ranking + cap 8,000 | 42.0% | 77.7% |
| **cap 8,000, no ranking at all** | **30.3%** | **96.0%** |

**The last row is the uncomfortable one, and it is not buried.** On aggregate a
cap with no model beats the whole scorer on both axes at once: more freed, and
far more of what got quoted still present. Per session it is less flattering —
across the 50 sessions with ten or more quoted passages the cap has sessions
that keep *none* of what was quoted from them, which the ranking does not — so
the cap ships as an addition to the ranking rather than a replacement for it.
Anyone who wants the honest minimum can set `keepThreshold: 0` and keep the cap.

`24000` is the default because it is the largest cap measured to free more while
leaving the tail exactly where it was. Per session, against shipping no cap:

| | median freed | median kept | 10th pct | worst | sessions under half |
| --- | --- | --- | --- | --- | --- |
| no cap | 7.3% | 97.3% | 69.2% | 37.5% | 2 |
| cap 24,000 | 9.4% | 96.5% | 69.2% | 37.5% | 2 |
| cap 16,000 | 14.8% | 94.5% | 67.6% | 37.5% | 3 |

16,000 doubles the median session's saving and costs one more session that keeps
under half of what it quoted. That is a defensible setting; it is not one a
default should take on anyone's behalf.

**Why a floor and a budget, not a threshold.** The scorer produces a ranking,
and that ranking generalises across sessions. An absolute probability cut does
not, because each session has its own mix of tools and so its own distribution:
a Bash-heavy session scores low throughout and a fixed cut sweeps all of it.
Calls are therefore dropped lowest-score-first only until `targetReduction` is
met, with `keepThreshold` as a floor nothing is dropped above. Simulated per
session on the labelled corpus (`eval/policy.ts`):

| policy | tool output freed | reused outputs kept | reused chars kept |
|---|---|---|---|
| absolute cut at 0.5 (an earlier default) | 95.3% | **8.9%** | 16.9% |
| **budget 0.5, floor 0.20 (shipped)** | 23.4% | **77.3%** | **92.2%** |
| budget 0.7, floor 0.20 | 33.9% | 68.8% | 90.2% |
| budget 0.7, floor 0.05 | 3.7% | 87.4% | 98.7% |

Run through the shipped code rather than the simulation above, the same defaults
give **33.7% freed, 77.7% of reused outputs kept and 87.9% of their characters** —
the differences are the cap and the one rule the sweep has no notion of, below.

Freeing nearly everything is easy and nearly worthless. This is why `calibrate`
is an accuracy upgrade rather than a prerequisite: the policy adapts to your
distribution without it.

### One rule the scorer does not get a vote on

An `Edit`, `Write`, `MultiEdit` or `NotebookEdit` call is never dropped. Its
*result* can be — "Applied 1 edit to src/auth.ts" is worth nothing, and exactly
1 of the 220 mutating calls in the corpus had an output that was ever needed
verbatim — but its *input* is the only record that the change happened, and
unlike a read it cannot be recovered by running it again.

This came out of the demonstration on the page: with the scorer left to itself,
it dropped the `Edit` that fixed the bug the session was about, because the
output was worthless and the file was not read again afterwards. Across the
corpus the rule applies to 220 such calls, and re-running the same decisions with
the guard removed shows what it actually saves: **15 of them** would otherwise
lose their call or their output, against the single output in those 220 that was
ever needed verbatim.

### What the other 22.3% costs

"77.7% of reused outputs kept" invites you to supply your own answer for the
rest, so `eval/recovery.ts` prices it. Held-out scores, shipped policy, per
session: **55 of the 247 reused outputs are dropped** — 1.34 per session, and
only one of them kept a head.

Forty-seven are command output reused verbatim in a later tool input. That is the
shape this scorer is worst at: most command output is never referred to again,
and the minority that is gets swept along with it. Four are `AskUserQuestion` — a
human's answer, which no amount of re-running brings back.

### What a real compaction actually costs the work

That figure over-counts, because it includes reuses that had already happened by
the time a compaction fired and so were never at risk. `eval/outcome.ts` asks the
question in the right order: find where the engine would actually fire — 60% of a
session's tool output — decide only the calls present at that moment, then count
the reuses that come *afterwards* whose source was dropped.

Across 32 sessions: 1,038 calls present when it fires, **68 reused only
afterwards, and 6 of those dropped**. That is **0.19 lost outputs per session**,
8.8% of what was genuinely still needed, and **27 of the 32 sessions lose nothing
at all**.

This is the necessary condition for the work to suffer, not proof that it did.
Nothing here replays an assistant against the compacted transcript, and that
remains unverified below.

## The neural sidecar this replaced

**There is no option that turns it back on.** `scorer` and `layaUrl` are read
and ignored, nothing shipped imports a client, and a settings file left over
from an older version is not an error. What is kept is the measurement, under
`eval/`, where it stays reproducible against a live sidecar:

```sh
uv tool install "laya[serve]"
LAYA_HOST=127.0.0.1 LAYA_DEVICE=cuda LAYA_PRELOAD=1 LAYA_MODELS=multilingual laya-serve
bun eval/score.ts        # the comparison
bun eval/sidecar-bench.ts  # the table below
```

`LAYA_HOST` defaults to `0.0.0.0`; set it explicitly. `LAYA_DEVICE=cuda`
matters: on `cpu` the router puts almost nothing on the card and every figure
below flatters it, which is how this section got two of them wrong once already.

`phrasing` is the one setting that outlived the sidecar, because the built-in
scorer reads each question's instructions too: on `typed-decisions`, `direct`
scores AUC 0.719 and `reproducible` 0.419, so the wording mattered more than the
checkpoint did.

### What it costs to run

Measured on one machine, RTX 4060 Laptop, one `laya-serve` process
(`eval/sidecar-bench.ts`, which needs the sidecar live):

| | |
|---|---|
| cold start to first answer | **7.6 s** |
| resident memory | **3.1 GB** at first answer, **4.9 GB** warm |
| VRAM | **~1.4 GB** for the one checkpoint measured resident on the card |
| latency, `multilingual`, 8 questions | **573 ms** median |
| latency, `english` / `typed-decisions`, 8 questions | 1,704 ms / 1,906 ms |

`laya-serve` loads every checkpoint at startup and routes per request, so memory
and start-up are properties of the router, not of any one checkpoint. Only
latency is per checkpoint.

Scoring this machine's sessions — 1,762 calls, two questions a request, eight in
flight — takes **41.0 s on the fastest checkpoint against 190 ms for the built-in
scorer**, holding ~4.9 GB of RAM and about 1.4 GB of VRAM the whole time. That is
216x the time for a lower AUC, which is the arithmetic behind the default.
Fine-tuning changes the AUC; it does not change this table.

Both of those figures are corrections. The block read 23.1 s and 122x until the
projection was checked: it divided the request count by the questions in a
request, and a request carries one call's two questions, so there is one request
per call and it halved itself. The VRAM said ~5 GB and had been read off a router
started with `LAYA_DEVICE=cpu`, which puts almost nothing on the card — the same
report shows 227 MiB of GPU memory in use beside it, and nobody read the two
lines together. 1.4 GB is the measured delta on the card when one checkpoint is
loaded with `LAYA_DEVICE=cuda`: 148 MiB before, 1,519 MiB after. Checked
end to end rather than re-derived: 159 calls through a CUDA sidecar took 3,960 ms
at concurrency 8, where the corrected arithmetic predicts 3,696 ms. Concurrency
buys nothing — 928 ms a call at one in flight, 1,002 ms at eight, because the GPU
serialises.

## What you repeat, and skills for it

The same reading of every tool call answers a second question: what does this
person do over and over? A thing done over and over is a skill nobody writes,
because noticing it is the hard part.

So the plugin counts the *shapes* it sees — a command with its arguments
collapsed, a run of three tools, a request in your own words — and ranks them.

```sh
npm run propose                 # the report; writes nothing
npm run propose -- --write 2    # drafts row 2 into .kompact/proposals/
```

Recording is local, on by default, and off with `recordSignals: false`. It keeps
signatures plus up to three redacted examples in the plugin's own store, mirrored
to `~/.claude/kompact-signals.json` so the CLI can read it. No raw output is stored,
nothing is sent anywhere, and drafts land in `.kompact/proposals/`, which Claude Code
does not read — promoting one is a `mv` you do yourself.

**This part is new and its usefulness is not established.** Replaying 2,417 tool
calls from 40 real sessions through the recorder's own functions, 27 of 2,000
recorded shapes repeated at all — and all 10 of the repeated *command* shapes
were generic shell verbs (`sed -n`, `grep -n | head`, `cat`). The classifier
works; whether what it proposes is worth writing is measured by nobody yet, and
has its own row in the verification ledger. `bun eval/signals-fixture.ts` runs
that replay on your own transcripts.

## Calibrate it on your own sessions

**The shipped coefficients were fitted on one person's 41 sessions.** Someone
whose work is mostly `Bash`, or mostly web research, or who works in a language
the labeller's eight-word shingles do not match, has a different distribution.
Nothing here detects that for you, so refitting is the expected step, not an
advanced one:

Before any of that, `npm run dry-run` answers the cheaper question — how much
this would free on *your* transcripts — by running the shipped `compact` over
`~/.claude/projects`. It prints two tables: what one compaction frees per
session, and then the loop, replayed the way production runs it, with the passes
it would take before handing over and the milliseconds each one costs. It
installs nothing, writes nothing, and needs no key.

```sh
npm run dry-run             # what it would free on your own sessions
npm run calibrate           # extract labels, then compare shipped vs refit
bun eval/calibrate.ts --write
```

It labels your own `~/.claude/projects` transcripts behaviourally — nothing is
sent anywhere — reports shipped against refit held out by session, and emits a
`KOMPACT_WEIGHTS` value for the `env` block of `~/.claude/settings.json`.
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

Two scripts need a live Laya sidecar and so are not part of `npm test`:
`npm run smoke` checks the sidecar answers in the direction the wording implies,
and `npm run ckpt` compares checkpoints on one transcript. Neither ran under any
script until now, which is how `eval/score.ts` came to default to the wrong port.

`npx kompact-serve --help` lists the rest: `--port`, `--host`, `--api-key`,
or `LAYA_COMPACT_PORT` / `LAYA_COMPACT_HOST` / `LAYA_COMPACT_API_KEY`. It also
answers `GET /health`, and rejects a body over 1 MB with `413`. Binding beyond
`127.0.0.1` without a key warns, because the endpoint takes arbitrary text.

`LayaClient` — the path to a real Laya sidecar, not this server — reads
`LAYA_URL` and `LAYA_API_KEY` from the environment when neither is passed.

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
| A compaction rarely costs the work | 32 sessions compacted where the engine would fire it: 6 of the 68 outputs reused afterwards were dropped, 0.19 a session, 27 sessions losing nothing (`eval/outcome.ts`) |
| Scoring beats the model it replaces | 1063 labelled calls, 18 sessions, 10 grouped splits: AUC 0.905 ± 0.078 vs 0.719 ± 0.026, winning 10/10 paired splits (`eval/repeat.ts`, transcribed into `eval/RESULTS.md`) |
| States never overflow the checkpoint | asserted for outputs from 0 to 2,000,000 chars |
| No orphaned `tool_use`/`tool_result` survives | the hook run over a **real** session from disk; an orphan is rejected by the API and would break the session compaction was meant to save |
| User and assistant prose is never touched | same real-session test |
| A dead sidecar never breaks a session | falls back to the built-in summary; asserted |
| One failed request never deletes anything | that call is kept; asserted |
| The Codex plugin works against the server | `jev-compact`'s own parser, pairing, scorer and HTTP client, driven over its recorded Codex rollout fixture, produce discriminating scores |
| The plugin loads in a real engine | `claude --plugin-dir .` with function hooks on |
| `turn.complete` fires and requests compaction | verified live: the hook was invoked in a real session, `$.session.usage()` returned a real percentage, and `$.session.compact()` was called |
| The loop takes several passes before handing over | the production loop replayed on real transcripts — compacted prefix plus real continuation, not a pass fed its own output: 9 passes taken across 3 sessions, none slower than 20 ms (`eval/passes.ts`). The hook's own side of it — counter, ceiling, cleared record — is driven over a real transcript from disk in `test/real-transcript.test.ts` |

**Not verified:** the engine invoking `session.compact` *in a live session* and
accepting the replacement message list. Forcing it needs genuine context
pressure — at 5-31% full the engine correctly declines to compact, and `/compact`
is a CLI command the model cannot invoke. Everything that handler does is covered
by the real-session test above; what is untested is the engine-side handoff,
which is the same API the upstream uses. To close it: open a session with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`, work until the
context bar is well along, then type `/compact` — the toast reports the reduction
and every decision lands in the log.

Also unverified: **what deferring the model summary costs**. Six passes run
before the engine's summary does, and how much room each one buys is measured
(`eval/passes.ts`). What an assistant loses by not getting a narrative summary
for six compactions is not: `applyDecisions` never touches prose, so what
survives is verbatim tool calls and the session's own words, which is a
different thing from a story about them. `maxPasses` exists so the summary
happens eventually, and its value is a judgement rather than a result.

Also unverified: **an assistant still finishing the job**. The measurement above
shows how often the information would no longer be there; whether that changes
what an assistant does needs the same session replayed both ways against a real
model, which is the next thing worth building.

And a live Codex CLI, which needs >= 0.155 (this machine has 0.131).

## Development

```sh
bun install
npm run typecheck   # src + test + eval + hooks
npm run test        # 219 tests
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
