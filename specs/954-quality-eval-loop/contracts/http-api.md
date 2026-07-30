# HTTP Contract: Quality Resolution and Eval Learning Loop

## Transition Quality triage

`PUT /api/v1/quality/turns/{assistantMessageId}/triage`

```json
{
  "state": "resolved",
  "expectedVersion": 2,
  "resolution": {
    "reason": "knowledge_gap",
    "note": "Updated the refund policy."
  }
}
```

Active states reject `resolution`. `dismissed` accepts only not-actionable
reasons. Terminal writes may omit `resolution` and are then reported as
`unspecified`. `other` requires a non-blank note. The deprecated top-level
`reason` string remains parseable and is never converted into a reason code.

```json
{
  "state": "dismissed",
  "expectedVersion": 2
}
```

Success returns the current record:

```json
{
  "state": "resolved",
  "version": 3,
  "resolution": {
    "reason": "knowledge_gap",
    "note": "Updated the refund policy."
  },
  "legacyReason": null,
  "closedAt": "2026-07-30T12:00:00.000Z",
  "updatedAt": "2026-07-30T12:00:00.000Z"
}
```

A stale version returns `409`:

```json
{
  "error": {
    "code": "QUALITY_TRIAGE_CONFLICT",
    "message": "Quality triage changed",
    "details": {
      "current": {
        "state": "acknowledged",
        "version": 3,
        "resolution": null,
        "legacyReason": null,
        "closedAt": null,
        "updatedAt": "2026-07-30T12:00:00.000Z"
      }
    }
  }
}
```

## List and stats

`GET /api/v1/quality/turns` adds:

- repeatable or CSV `resolutionReason` query values;
- `resolutionFrom` (inclusive) and `resolutionTo` (exclusive) for the latest
  terminal transition, distinct from message-creation `from`/`to`;
- `triage.version`, structured `triage.resolution`, and `legacyReason`;
- `verification`, either the Eval projection or `null`.

`GET /api/v1/quality/stats` adds `resolutionBreakdown`, grouped by current
terminal state and typed reason or `unspecified`, inside the selected range.
Breakdown links set terminal state, reason, transition window, and the explicit
all-turn scope so the default active-signal queue cannot hide matching rows.

## Find or create Eval by assistant message

`PUT /api/v1/evals/cases/by-source-message/{assistantMessageId}` has no body.
It derives the workspace conversation, validates assistant authorship, and uses
a server-owned case name.

```json
{
  "case": { "id": "..." },
  "snapshot": { "id": "..." },
  "created": true
}
```

Repeating or racing the call returns the existing immutable snapshot and case
with `created: false`; it never resets the case.

`GET /api/v1/evals/cases/by-source-message/{assistantMessageId}` returns the
same case/snapshot association without creating. A missing association uses the
existing `404` error shape.

Both endpoints require the existing Eval query permission and enforce workspace
scope.

## Generated surfaces

The runtime/code-first schemas are registered under
`backend/src/app/http/openapi/`. Generated `backend/openapi.*`,
`typescript-sdk`, and MCP OpenAPI types move together. No worker or AMQP
contract changes.
