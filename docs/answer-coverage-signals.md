---
title: "Answer Coverage Signals"
description: "Read semantic answer coverage in turn diagnostics and Audience Pulse, and use it to steer directives and routines."
last_updated: 2026-09-16
---

# Answer Coverage Signals

Answer coverage tells you whether the agent resolved the visitor's contextualized request. It is shown beside retrieval grounding, citation support, execution outcome, and follow-up progress, so a response can cite useful material while still leaving an actual request unanswered.

## Author a reaction

In a directive editor, choose the coverage values and optional reasons that should make the rule eligible. For a routine, keep its **Starts when** trigger as the description of the visitor task. Open that line, then choose **Add condition** and **Answer coverage** when the flow also requires a recorded assessment. The available coverage values are **Answered**, **Partly answered**, **Unanswered**, and **Needs clarification**. Reasons include sufficient evidence, insufficient evidence, conflicting evidence, ambiguous request, and intentional scope boundary.

The routine’s semantic trigger and coverage condition both have to match. The agent forms the coverage verdict as it starts writing the answer — after the evidence is in hand, but before any answer text exists — so a routine whose condition matches takes the turn with no answer ever shown to the visitor. Existing routine confirmation, capability, reentry, and interruption rules still apply. When a routine starts from an `unanswered` coverage condition, its first reply says that the request could not be answered and then follows the first step in the same message, so a visitor who asked something the agent has no material for hears both the limit and the offer. `Partly answered` and `Needs clarification` coverage starts the authored step without forcing that refusal, because those assessments do not mean the agent had no answer. An offer remains an offer until the visitor accepts it, and completing a routine does not rewrite the originating assessment. A reaction can link to the actual message it targeted; selecting that link opens the matching Activity turn, where you can inspect its Flow.

A draft test chat and an eval replay assess coverage the same way, so you can try a coverage-gated directive or routine on the agent's draft before you publish. Those turns keep the assessment in the turn's Flow only; they store no assessment record and no reaction trace.

## Inspect a turn

Open a turn's debug view to see its contextualized request, assessment availability, coverage, reason, unresolved request, originating IDs, schema version, and assessment time. The reaction trace records whether coverage criteria were evaluated, whether there was no match, and which directive or routine was applied, offered, activated, skipped, or suppressed.

An assessment with `not_recorded`, `failed`, or `invalid` availability is displayed as **Not assessed**. The debug view does not infer a semantic answer from citations or a successful routine action.

The Activity outcome uses a coverage-specific label when coverage was assessed:
**Request answered**, **Partly answered**, **Request unanswered**, or
**Needs clarification**. These are separate from **Coverage not assessed**, which
marks unavailable or legacy evaluation, and **No context**, which means the
retrieval answer path actually declined the request.

## Read Audience Pulse

Expanded topic details show exclusive semantic buckets for answered, partly answered, unanswered, needs clarification, and not assessed questions. Grounding counts remain a separate diagnostic. Pulse evidence carries the recorded assessment; unresolved request text and routine reaction details stay in authorized turn diagnostics.

Reports preserve records created before answer coverage was measured. Those records appear as legacy evidence and remain readable without manufacturing a new assessment.

## Shadow assessor

A retrieval turn with admitted evidence also runs a second, off-path coverage call whose only job is comparing its verdict against the recorded one. The comparison never changes an answer, a directive, a routine, or the reaction trace, and it never runs against a draft test chat or an eval replay. Set `ANSWER_COVERAGE_SHADOW_ASSESSOR_ENABLED=false` in the backend environment to turn it off.
