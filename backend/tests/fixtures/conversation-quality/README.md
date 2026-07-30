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
| `corpus.ts` | 4 seed documents with quotable facts (30-day refund, $49 Pro plan, SOC 2 Type II) |
| `routines.ts` | 2 seed `RoutineDefinition`s: `contact-support`, `book-demo` |
| `directives.ts` | 3 seed `AuthoredDirective`s: pricing-precision, refund-empathy, security-precision |
| `agent.ts` | the single seed agent (retrieval on, directives attached) all cases run against |
| `cases.ts` | the 19 seed cases |
| `baseline.json` | committed per-case verdicts; the run diffs against this and fails on regression |

## Assertion vocabulary

Two layers (see `src/modules/eval/suite/`):

- **Deterministic (no LLM, gate every run):** `turn_route`, `turn_uses_skill`,
  `turn_activates_routine`, `routine_step_reached`, `turn_asks_clarification`,
  `turn_grounding_verdict`, plus the product `retrieval_*`, `answer_cites_document`,
  `answer_contains` / `answer_does_not_contain`.
- **Semantic (LLM judge, paid/non-deterministic):** `llm_judge` — reserved for empathy,
  refusal, precision. Run these on-demand/nightly, not on every PR.

## Running it

```bash
cd backend
# Point at a disposable agent to seed + run against; a document worker must be running.
export RADIOSO_EVAL_WORKSPACE_ID=... RADIOSO_EVAL_AGENT_ID=...
pnpm run evals:update-baseline # FIRST: record current behaviour into baseline.json
pnpm run evals                 # thereafter: run + gate against the baseline
pnpm run evals -- --tag routine # only cases carrying a tag (repeatable)
```

`baseline.json` ships empty. Regression gating keys off it: only a case that *used to
pass and now doesn't* fails the run, so a case that was already failing (e.g. the flaky
clarification case) does not fail CI until it's fixed and re-baselined. **Because an empty
baseline can't gate, the runner fails loudly in run mode until you initialize it** — run
`pnpm run evals:update-baseline` once against a known-good run first.

`--judge` (llm_judge grading) is not wired yet — it's a fast-follow (needs a judge seam).
The runner rejects the flag and scores the deterministic layer only.

## Sampling — making the baseline gate-worthy

LLM turns vary run-to-run: a case can pass one run and fail the next (e.g. an emotional
complaint that routes to retrieval one time and answers directly the next). A single-run
baseline therefore produces false regressions. Sampling fixes this:

```bash
pnpm run evals -- --samples 5                 # run each case 5×, reduce to a stable status
pnpm run evals:ci                              # same, as a named script
pnpm run evals -- --samples 5 --pass-threshold 0.8  # tolerate one flaky sample in five
pnpm run evals:update-baseline -- --samples 5  # record a gate-worthy baseline
```

Each case runs K times; its reduced status is `pass` only when the per-sample pass rate
clears `--pass-threshold` (default `1.0`, unanimous). Because a flaky case can't clear the
threshold, it's recorded as `fail` in the baseline and never gates until it's genuinely
stable — so a `pass` baseline entry is one that reliably passes, and a real regression is
unambiguous. The report marks cases whose samples disagreed as **flaky**. Record the
baseline and run CI with the same `--samples`/`--pass-threshold`.

## Adding a case

Append to `cases.ts`, prefer deterministic assertions, reserve `llm_judge` for what a
regex can't check, then run `pnpm run evals:update-baseline`. Keep ids stable — the
baseline keys on them.
