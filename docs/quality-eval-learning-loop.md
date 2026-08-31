---
title: "Close the Quality Loop with Evals"
description: "Close answer-quality reviews, optionally classify the outcome, preserve weak turns as Eval cases, and verify the fix."
last_updated: 2026-08-31
---

# Close the Quality Loop with Evals

The Quality queue is where an operator turns a weak assistant answer into a
decision Radioso can learn from. A useful review has three parts:

1. close the item, with a classification when it adds useful context,
2. preserve the failed turn as an Eval case, and
3. rerun that case after the underlying fix.

## Close a review

Open **Quality → Review**, choose **Resolve** or **Dismiss**. A small popover
lets you close immediately or add an optional classification for reporting:

- resolved: **Knowledge gap**, **Retrieval issue**, **Agent behavior**,
  **Platform bug**, or **Other**;
- dismissed: **Expected behavior**, **Out of scope**, **Invalid feedback**, or
  **Other**.

Choose **Close without reason** when classification would only slow down the
queue. `Other` opens a note field and requires a note; the other choices close
the review in one click. Notes are limited to 500 characters. They appear in
the turn detail but are deliberately excluded from aggregate reporting and the
transition audit.

If another operator changes the review while the popover is open, Radioso shows
a confirmation dialog with the current and proposed decisions. It never
silently overwrites the newer update. Reopening a closed review clears its
resolution and removes it from terminal-resolution reports.

## Preserve and verify the failure

Choose **Add to Eval** on an unlinked turn. Radioso captures the exact source
turn and creates a default case in one idempotent operation. Once linked, the
action becomes **Open Eval**. The case starts without assertions, so open it and
choose what the rerun should prove before running it.

The Quality row shows the case state and the latest run result. Passing and
failing evidence includes the run time so an operator can tell whether the test
predates the fix. A passing result offers **Review and resolve**; it opens the
normal close-review flow and never chooses a resolution reason for you.

## Learn from closed reviews

The compact **Resolution reasons** breakdown groups current terminal decisions
in the selected 7- or 30-day closure window by state and structured reason.
Select a group to open the exact matching turns.
The resulting queue keeps the state, reason, and terminal closure window in the
URL, so it can be shared with another operator.

Closures stored without a structured reason are shown as **Reason unspecified**.
They are never guessed from older free-form text.

## API

Triage writes use optimistic concurrency:

```http
PUT /api/v1/quality/turns/{assistantMessageId}/triage
Content-Type: application/json

{
  "state": "resolved",
  "expectedVersion": 2,
  "resolution": {
    "reason": "retrieval_issue",
    "note": "Relevant policy ranked below an older duplicate."
  }
}
```

Active states omit `resolution`. A stale `expectedVersion` returns `409
QUALITY_TRIAGE_CONFLICT` with the current triage record in
`error.details.current`.

Terminal states may also omit `resolution`:

```json
{
  "state": "dismissed",
  "expectedVersion": 2
}
```

That closes the review without classification. The response returns
`resolution: null`.

`GET /api/v1/quality/turns` accepts a `signal` filter that narrows the list to
one or more classes of issue: `negative_feedback`, `grounding_gaps`, or
`skill_failures`. Pass several as a comma-separated list or repeat the
parameter; the result is the union, and a turn matching more than one signal is
listed once. The other filters apply on top of the signal match. The
dashboard's queue asks for every signal in an `open` or `acknowledged` state by
default, so the table holds the backlog rather than every answer the agent has
ever given; its **All answers** toggle drops both defaults.

For an active thumbs-down queue, combine `sort=negative_feedback_updated_at`
with `activeNegativeFeedbackOnly=true`. Results are ordered by the latest
feedback creation or edit, feedback newer than an earlier resolved or dismissed
decision is treated as open, and each turn carries
`feedback.latestDownUpdatedAt`.

Use `resolutionReason` to filter turns by one or more reasons. `unspecified`
selects terminal records without a structured reason. `resolutionFrom` and `resolutionTo` filter the
terminal closure timestamp; they are distinct from `from` and `to`, which filter
assistant-turn creation time.

`GET /api/v1/quality/stats` returns the rates behind those turns plus a
current-window structured `resolutionBreakdown`: a rolling `7d` or `30d`
window, the equal-length window before it for comparison, one bucket per UTC
day, and the all-time count of turns still awaiting triage for each signal.
Every rate ships with the population it is measured over and reports `null`
instead of a rate when that population is empty. Both quality endpoints read
the same turns, and both exclude operator activity — dashboard test chats,
workbench replays, Ray's agent-turn probes, and replies a human teammate wrote
during a takeover — so operator work does not distort the numbers.

The Eval convenience endpoints are workspace-scoped:

```http
GET /api/v1/evals/cases/by-source-message/{assistantMessageId}
PUT /api/v1/evals/cases/by-source-message/{assistantMessageId}
```

`GET` is read-only. `PUT` atomically returns the existing association or creates
one case and one immutable snapshot. Concurrent retries converge on that same
association. The generic snapshot and case endpoints remain available when a
client needs to provide its own name or assertions.
