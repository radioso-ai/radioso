---
title: "Answer Coverage Signals"
description: "Read semantic answer coverage in turn diagnostics and Audience Pulse, and use it to steer directives and routines."
last_updated: 2026-11-19
---

# Answer Coverage Signals

Answer coverage tells you whether the agent resolved the visitor's contextualized request. It is shown beside retrieval grounding, citation support, execution outcome, and follow-up progress, so a response can cite useful material while still leaving an actual request unanswered.

The request includes the subject the conversation established. A visitor who names a course and then asks for "a full quote for the event" is asking about that course, so prices the agent found for a different course leave the request **Unanswered**. Spelling variants, translations, and aliases of the subject still count as the same subject.

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

Audience Pulse splits every visitor question in the last 30 days into five parts, and the same split appears for the whole window under the headline tiles and for each topic when you expand its row:

```text
Answered 10,090 · 71%   No answer in your content 1,279 · 9%   Partly answered or unclear 1,563 · 11%
Outside what the agent covers 853 · 6%   Not assessed 427 · 3%
```

**No answer in your content** is the part you can fix by writing: the agent fell short because your documents had nothing, or too little, to answer from. **Partly answered or unclear** is the rest of the partly answered, unanswered, and needs-clarification questions. **Outside what the agent covers** is a question the agent declined on purpose: its assessment is partly answered or unanswered with the intentional scope boundary reason, so the agent did what you authored. A question with no assessment record reads from its answer instead: a grounded answer counts as answered, and a retrieval answer that found partial or no support in your documents counts as partly answered or unanswered. **Not assessed** covers the rest: an assessment that was unavailable, failed, or still pending, and an unassessed answer that was neither. When a saved report carries no answer coverage at all, its counts come from retrieval grounding.

The tiles compare the window with the 30 days before it: question and conversation counts in percent, the answered and no-answer rates in points. A comparison needs at least 50 questions in each window, and a topic row under 50 questions shows its answered count as **32 of 38** rather than a percentage, with no comparison or trend. The **vs** column compares each topic's share of all questions with the report it was last seen in, and marks a topic that appeared since as **New**.

Expand a topic for up to five of its questions, each with the turn inspector's label: **Answered**, **Unanswered**, **Partly answered**, **Needs clarification**, **Out of scope**, or **Not assessed**. A question asked more than once shows its count, such as **asked 3×**, and each one opens its conversation in Activity.

**Content to write** lists the topics with questions that had no answer in your content, the most first. **Draft** opens the document composer seeded with the questions to cover; once the document is saved, the row says when it was added. **Not for us** takes a topic off the list without changing any count, and **Restore** brings it back. Unresolved request text and routine reaction details stay in authorized turn diagnostics.

## Shadow assessor

A retrieval turn with admitted evidence also runs a second, off-path coverage call whose only job is comparing its verdict against the recorded one. The comparison never changes an answer, a directive, a routine, or the reaction trace, and it never runs against a draft test chat or an eval replay. Set `ANSWER_COVERAGE_SHADOW_ASSESSOR_ENABLED=false` in the backend environment to turn it off.
