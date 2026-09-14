---
title: "Answer Coverage Signals"
description: "Read semantic answer coverage in turn diagnostics and Audience Pulse, and use it to steer directives and routines."
last_updated: 2026-09-09
---

# Answer Coverage Signals

Answer coverage tells you whether the agent resolved the visitor's contextualized request. It is shown beside retrieval grounding, citation support, execution outcome, and follow-up progress, so a response can cite useful material while still leaving an actual request unanswered.

## Author a reaction

In a directive editor, choose the coverage values and optional reasons that should make the rule eligible. For a routine, keep its **Starts when** trigger as the description of the visitor task. Open that line, then choose **Add condition** and **Answer coverage** when the flow also requires a recorded assessment. The available coverage values are **Answered**, **Partly answered**, **Unanswered**, and **Needs clarification**. Reasons include sufficient evidence, insufficient evidence, conflicting evidence, ambiguous request, and intentional scope boundary.

The routine’s semantic trigger and coverage condition both have to match. The rule receives the recorded assessment after evidence is available. Existing routine confirmation, capability, reentry, and interruption rules still apply. An offer remains an offer until the visitor accepts it, and completing a routine does not rewrite the originating assessment. A reaction can link to the actual message it targeted; selecting that link opens the matching Activity turn, where you can inspect its Flow.

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
