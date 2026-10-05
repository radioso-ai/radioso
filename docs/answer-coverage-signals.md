---
title: "Answer Coverage Signals"
description: "Read semantic answer coverage in turn diagnostics and Audience Pulse, and use it to steer directives and routines."
last_updated: 2026-10-05
---

# Answer Coverage Signals

Answer coverage tells you whether the agent resolved the visitor's contextualized request. It is shown beside retrieval grounding, citation support, execution outcome, and follow-up progress, so a response can cite useful material while still leaving an actual request unanswered.

## Author a reaction

In a directive editor, choose the coverage values and optional reasons that should make the rule eligible. For a routine, keep its **Starts when** trigger as the description of the visitor task. Open that line, then choose **Add condition** and **Answer coverage** when the flow also requires a recorded assessment. The available coverage values are **Answered**, **Partly answered**, **Unanswered**, and **Needs clarification**. Reasons include sufficient evidence, insufficient evidence, conflicting evidence, ambiguous request, and intentional scope boundary.

The routine’s semantic trigger and coverage condition both have to match. The agent forms the coverage verdict as it starts writing the answer — after the evidence is in hand, but before any answer text exists — so a routine whose condition matches takes the turn with no answer ever shown to the visitor. Existing routine confirmation, capability, reentry, and interruption rules still apply. When a routine starts from an `unanswered` coverage condition, its first reply says that the request could not be answered and then follows the first step in the same message, so a visitor who asked something the agent has no material for hears both the limit and the offer. `Partly answered` and `Needs clarification` coverage starts the authored step without forcing that refusal, because those assessments do not mean the agent had no answer. An offer remains an offer until the visitor accepts it, and completing a routine does not rewrite the originating assessment. A reaction can link to the actual message it targeted; selecting that link opens the matching Activity turn, where you can inspect its Flow.

A draft test chat and an eval replay assess coverage the same way, so you can try a coverage-gated directive or routine on the agent's draft before you publish. Those turns keep the assessment in the turn's Flow only; they store no assessment record and no reaction trace.

## Inspect a turn

Open a turn's debug view to see its contextualized request, assessment availability, coverage, reason, unresolved request, originating IDs, schema version, and assessment time. The reaction trace records whether coverage criteria were evaluated, whether there was no match, and which directive or routine was applied, offered, activated, skipped, or suppressed.

An assessment with `not_recorded`, `failed`, or `invalid` availability is displayed as **Not assessed**. The debug view does not infer a semantic answer from citations or a successful routine action. The intentional scope boundary reason reads **Out of scope**, so an unanswered decline shows as **Unanswered · Out of scope** in the turn's Flow.

The Activity outcome uses a coverage-specific label when coverage was assessed:
**Request answered**, **Partly answered**, **Request unanswered**, or
**Needs clarification**. These are separate from **Coverage not assessed**, which
marks unavailable or legacy evaluation, and **No context**, which means the
retrieval answer path actually declined the request.

## Read Audience Pulse

Each topic row answers two questions: what visitors ask, and where the agent falls short. The topic's title sits on the first line and its counts on the second:

```text
Book, ebook, and audiobook details and access
19 questions · 2 unanswered · 2 partly answered
```

That row says 19 questions landed in the topic, 2 went unanswered, and 2 got only part of an answer. A topic where nothing went unanswered or partly answered shows only its question count.

Expand a topic for one line of answer counts across all its questions, such as **11 answered · 2 unanswered · 2 partly answered · 1 out of scope · 3 not assessed** for the 19 above. The collapsed row repeats the unanswered and partly answered numbers from this line, so the two always agree. The counts and the example questions under them use the turn inspector's labels: **Answered**, **Unanswered**, **Partly answered**, **Needs clarification**, **Out of scope**, and **Not assessed**.

**Out of scope** is a question the agent declined on purpose: its assessment is partly answered or unanswered with the intentional scope boundary reason. The agent did what you authored, so the decline is one bucket on the counts line and stays off the collapsed row, which keeps that row to the questions where the agent fell short. A question with no assessment record reads from its answer instead: a grounded answer counts as answered, and a retrieval answer that found partial or no support in your documents counts as partly answered or unanswered. **Not assessed** covers the rest: an assessment that was unavailable, failed, or still pending, and an unassessed answer that was neither. When a saved report carries no answer coverage at all, its counts come from retrieval grounding: grounded answers count as answered, degraded ones as partly answered, unsupported ones as unanswered, and the rest as not assessed. That report's examples carry no label, because none of them has a verdict of its own.

The examples are a sample of up to twelve of the topic's questions, and their heading says how many are shown, such as **Examples · 3 of 9 questions**. The sample takes the topic's unanswered and partly answered questions first and fills any remaining places from the rest of the topic. A question asked more than once appears once for each label it earned, with its count, such as **asked 3×**. Each example opens its conversation in Activity. When the topic has a content opportunity, **Start draft** opens the document composer seeded with its questions. Unresolved request text and routine reaction details stay in authorized turn diagnostics.

## Shadow assessor

A retrieval turn with admitted evidence also runs a second, off-path coverage call whose only job is comparing its verdict against the recorded one. The comparison never changes an answer, a directive, a routine, or the reaction trace, and it never runs against a draft test chat or an eval replay. Set `ANSWER_COVERAGE_SHADOW_ASSESSOR_ENABLED=false` in the backend environment to turn it off.
