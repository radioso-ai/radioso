# Conversation-quality eval suite

A committed, version-controlled dataset that exercises **conversation quality** — routing,
retrieval, grounding, directives, routines, clarification — so quality regressions show up
in a PR diff instead of requiring manual eval-over-API inspection.

This complements the DB-backed product eval harness (`src/modules/eval/`): that one is an
operator surface (snapshot a real conversation, replay in the dashboard); this one is a
repo-committed regression suite you run from the CLI.

## What's here

| File | What it is |
|------|------------|
| `corpus.ts` | 7 seed documents with quotable facts (30-day refund, $49 Pro plan, SOC 2 Type II, and two residential courses priced differently) |
| `routines.ts` | 2 seed `RoutineDefinition`s: `contact-support`, `book-demo` |
| `directives.ts` | 4 seed `AuthoredDirective`s: pricing-precision, refund-empathy, security-precision, maximally-helpful; plus `contact-form-only`, which only the `routine-step-outranks-always-on-handoff-directive` case adds, and `listed-languages`, which only the `quick-reply-unlisted-language-standing-directive` case adds, both through `agentConfigOverride` |
| `agent.ts` | the single seed agent (retrieval on, directives attached) all cases run against |
| `cases.ts` | the 48 seed cases |
| `baseline.json` | committed per-case verdicts; the run diffs against this and fails on regression |

## Assertion vocabulary

Two layers (see `src/modules/eval/suite/`):

- **Deterministic (no LLM, gate every run):** `turn_route`, `turn_uses_skill`,
  `turn_activates_routine`, `routine_step_reached`, `routine_yielded`, `turn_asks_clarification`,
  `turn_grounding_verdict`, `turn_answer_coverage`, `turn_persists_no_reply`, `turn_reply_source`,
  plus the product `retrieval_*`, `answer_cites_document`, `answer_contains` /
  `answer_does_not_contain`.
- **Semantic (LLM judge, paid/non-deterministic):** `llm_judge` — reserved for empathy,
  refusal, precision, and the quick-reply "no factual proposition" checks. The live runner
  drops them unless a case carries a tag passed with `--judge-tag`; those are graded on the
  cheapest text model the configuration resolves (the rerank tier, or `--judge-model`).
  `evals`, `evals:ci`, `evals:update-baseline`, and the nightly workflow all pass
  `--judge-tag quick-reply`, so the quick-reply judge assertions gate every run and the
  baseline is recorded the way the gate runs.

## Quick-reply cases

The `quick-reply`-tagged cases cover the turn planner's quick-reply lane. On a turn of pure
conversational mechanics (a greeting, thanks, a farewell, an acknowledgement) the planner
writes the reply itself and the composer never runs; `turn_reply_source` reads that from the
compose stage, which records `source: "turn_planning"` for a planner-written answer. The
positive cases, in English and Italian, assert `turn_planning`; the adversarial cases (mechanics
mixed with a question or a request, an open question or offer in the conversation, a capability
or price question, a request to repeat) assert `composer`. The unlisted-language case accepts
either source: an always-on directive names the agent's languages, and the reply may repeat it
word for word but claim nothing more. The judge rubric allows no factual proposition about
anything except text a standing instruction supplies word for word. A courtesy about the
assistant's own willingness or pleasure to help (for example, saying it's glad it could help)
is not a factual proposition either; a claim about what the assistant can do still is, since
that's a proposition about its abilities. The positive cases' references describe the expected
reply (kind, language, no facts) rather than quoting one.
Run only these cases with:

```bash
pnpm run evals -- --tag quick-reply
```

## Review cases

A case with `executionMode: "review"` runs as the email channel runs a turn: its `history` and
`query` are recorded as the conversation, and the runner's `review` port answers the recorded
customer message as a draft. No reply is persisted and no routine runs, so a review case takes
only `query` and `history`. Its coverage verdict comes from the review facts rather than the
turn trace, and `turn_persists_no_reply` checks that the conversation gained no assistant
message. A runner without a `review` port scores review cases as errors instead of running
them live. The `email`-tagged cases are review cases.

The live runner publishes the seeded agent before it runs review cases, so a review turn runs
the published revision, as the email channel does. Publishing refuses a routine whose tool step
names a skill the agent lacks, so the runner adds every skill the seeded routines dispatch as a
webhook skill on a loopback destination, publishes, and removes them before any case runs. A live
case that reaches one of those steps therefore finds no such skill, whichever cases the run
selects. When a routine starts dispatching a new skill, add it to `seededRoutineSkillNames` in
`scripts/runEvals.ts`; a unit test fails until you do.

A live review turn can ask the customer which sense they mean instead of answering. That ask is a
non-retrieval reply, so its facts carry no grounding or coverage verdict, and the `email` cases
assert only `turn_persists_no_reply`.

## Running it

```bash
cd backend
# Point at a disposable agent to seed + run against; a document worker must be running.
export RADIOSO_EVAL_WORKSPACE_ID=... RADIOSO_EVAL_AGENT_ID=...
pnpm run evals:update-baseline # FIRST: record current behaviour into baseline.json (5 samples)
pnpm run evals                 # thereafter: run + gate against the baseline (5 samples)
pnpm run evals -- --tag routine # only cases carrying a tag (repeatable)
```

`baseline.json` must cover every case selected for a normal run. The runner fails when a
case is missing, rather than treating it as an informational addition, so add a case and
record its observed outcome together. A case that was already failing does not fail merely
because it remains failing, but sampled baselines also retain the observed pass rate: a
case recorded at 4/5 and later falling to 0/5 is reported as a rate regression. When the
baseline and the run are both sampled, a case recorded `pass` regresses only when its pass
rate falls by more than half; a smaller drop is reported as within sampling noise and does
not fail the run. A run that
samples less deeply than its baseline also fails, because it cannot make a reliable comparison.
The current `--pass-threshold` must equal the recorded threshold; changing it requires a full
baseline re-recording rather than comparing statuses reduced under different rules.

A case tagged `judge-zero-tolerance` (`ZERO_TOLERANCE_JUDGE_TAG`) holds its `llm_judge`
assertions to zero tolerance: the share of samples in which no judge verdict failed must stay
at the case's recorded pass rate, so a case recorded at 5/5 fails the run on the first sample
whose judge fails, at any sampling depth, even while its case rate stays within the general
tolerance. The quick-reply positive cases and the unlisted-language case carry it, because one
reply that states a fact is the defect their "no factual proposition" judge exists to catch. A
judge error is not a failed verdict and counts only against the case rate. Every other
assertion, and every other case, keeps the general tolerance; that includes
`quick-reply-not-ack-pending-clarification`, whose judge grades the composer's wording of
the re-asked question.

**Because an empty baseline can't gate, the runner fails loudly in run mode until you
initialize it** — run `pnpm run evals:update-baseline` once against a known-good run first.

`--judge` (llm_judge grading) is not wired yet — it's a fast-follow (needs a judge seam).
The runner rejects the flag and scores the deterministic layer only.

## Sampling — making the baseline gate-worthy

LLM turns vary run-to-run: a case can pass one run and fail the next (e.g. an emotional
complaint that routes to retrieval one time and answers directly the next). A single-run
baseline therefore produces false regressions. Sampling fixes this:

```bash
pnpm run evals                                 # run each case 5×, reduce to a stable status
pnpm run evals:ci                              # same five-sample gated shape as the nightly workflow
pnpm run evals -- --samples 5 --pass-threshold 0.8  # tolerate one flaky sample in five
pnpm run evals:update-baseline                 # record a gate-worthy five-sample baseline
```

Each case runs K times; its reduced status is `pass` only when the per-sample pass rate
clears `--pass-threshold` (default `1.0`, unanimous). The recorded baseline keeps that
status alongside the measured pass rate, sample count, and threshold. A flaky case usually
can't clear the threshold, so it's usually recorded as `fail` — but a case that passes four
runs in five still records 5/5 often enough, so a `pass` entry's status alone is not
evidence that it reliably passes. That's why the gate compares sampled pass rates rather
than statuses. The report marks cases whose samples disagreed as **flaky**.
Record the baseline and run CI with the same `--samples`/`--pass-threshold`. A tag-filtered
`--update-baseline` updates only the selected entries and preserves all other committed entries;
it cannot change the recorded threshold because the unselected entries were not re-observed.

## Adding a case

Append to `cases.ts`, prefer deterministic assertions, reserve `llm_judge` for what a
regex can't check, then run `pnpm run evals:update-baseline`. Keep ids stable — the
baseline keys on them.
