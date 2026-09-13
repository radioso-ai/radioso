# Data Model: Confirmed Operator MCP Authoring

## Reviewed operation (shared proposal and invocation)

| Field | Meaning |
|---|---|
| proposal id / operationId | Reviewed artifact identity and caller-supplied idempotency identity. |
| kind | Routine, retrieval, or publication execution target. |
| principal binding | Workspace, account, user, grant and client identity that prepared it. |
| review digest | Canonical digest of the review payload the client presents for confirmation. |
| fences | Routine/draft/settings/publication versions relevant to the operation. |
| status | Prepared, canceled, executing, applied, refused, failed, or expired. |
| result reference | Safe reconciliable reference, never raw configuration content. |

The proposal holds review state; its execution invocation holds the receipt. Transitions are `prepared → executing → applied|refused|failed` and `prepared → canceled|expired`. Terminal states are idempotently readable. Only `prepared` may execute, and only once for its bound caller. A crash after a domain effect leaves the invocation claimed; reconciliation asks the owning domain whether that exact effect landed before it can settle the receipt. It never changes an uncertain effect to retryable merely because the receipt is incomplete.

## Publication candidate

An immutable review artifact containing agent id, draft generation, expected
published revision, complete release diff and validation. Its identity is part
of the reviewed operation; it is not bearer authority.

## Routine transform

A typed atomic command set over stable step/slot/ending ids. It contains exact
edge identity and replacement for connection changes and a complete ordinal
list for reorder. The persisted result must pass the routine owner's existing
validation.
