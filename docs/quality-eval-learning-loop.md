---
title: "Close the Quality Loop with Evals"
description: "Resolve answer-quality reviews with structured reasons, preserve weak turns as Eval cases, and verify the fix."
last_updated: 2026-07-30
---

# Close the Quality Loop with Evals

The Quality queue is where an operator turns a weak assistant answer into a
decision Radioso can learn from. A useful review has three parts:

1. close the item with a structured reason,
2. preserve the failed turn as an Eval case, and
3. rerun that case after the underlying fix.

## Close a review

Open **Activity → Quality** or **Needs attention**, choose **Resolve** or
**Dismiss**, and select a reason. The two surfaces use the same dialog and the
same rules:

- resolved: **Knowledge gap**, **Retrieval issue**, **Agent behavior**,
  **Platform bug**, or **Other**;
- dismissed: **Expected behavior**, **Out of scope**, **Invalid feedback**, or
  **Other**.

`Other` requires a note. Notes are limited to 500 characters. They appear in the
turn detail but are deliberately excluded from aggregate reporting and the
transition audit.

If another operator changes the review while your dialog is open, Radioso keeps
the dialog open, shows the current decision, and lets you reconsider. It never
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

Use `resolutionReason` to filter turns by one or more reasons. `unspecified`
selects terminal records without a structured reason. `resolutionFrom` and `resolutionTo` filter the
terminal closure timestamp; they are distinct from `from` and `to`, which filter
assistant-turn creation time. `GET /api/v1/quality/stats` includes
`resolutionBreakdown`.

The Eval convenience endpoints are workspace-scoped:

```http
GET /api/v1/evals/cases/by-source-message/{assistantMessageId}
PUT /api/v1/evals/cases/by-source-message/{assistantMessageId}
```

`GET` is read-only. `PUT` atomically returns the existing association or creates
one case and one immutable snapshot. Concurrent retries converge on that same
association. The generic snapshot and case endpoints remain available when a
client needs to provide its own name or assertions.
