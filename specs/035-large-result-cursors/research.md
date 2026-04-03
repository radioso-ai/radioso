# Research Notes: High-Cardinality Cursor Hardening

## Current Findings

- Documents, chat history, anonymous history, and message detail endpoints
  already expose bounded request shapes in the route layer, but multiple paths
  still rely on `limit + offset`.
- The repo still contains unbounded repository reads for hot entities such as
  documents and conversations.
- Conversation detail already has bounded window semantics, making it the best
  starting point for cursor migration.

## Design Decisions

### Decision 1: Use opaque cursors, not exposed sort keys

- **Why**: Keeps client contracts stable and avoids exposing backend ordering
  internals as durable public API.
- **Consequence**: Backend owns encoding and validation. Frontend stores and
  forwards opaque tokens only.

### Decision 2: Use deterministic timestamp-plus-id ordering

- **Why**: Collection sorts already depend on recency. Timestamp alone is not a
  safe cursor boundary because ties are possible.
- **Consequence**: Every cursor-aware collection query needs a stable secondary
  tie-breaker using the primary key.

### Decision 3: Preserve summary-vs-detail separation

- **Why**: Large-result-set hardening fails if list routes keep returning full
  document bodies or full message histories.
- **Consequence**: Summary routes should keep summary payloads only; detail
  endpoints remain separate and independently bounded.

### Decision 4: Keep exact totals only where justified

- **Why**: Exact `COUNT(*)` can become expensive on very large collections and
  should not define the traversal contract.
- **Consequence**: Cursor-based `hasMore` and `nextCursor` become mandatory.
  Exact totals may remain temporarily during migration for UX continuity but
  should be treated as secondary.

## Open Implementation Questions For Tasking

- Which existing UI surfaces truly require an exact total versus just next/prev
  continuation?
- Does document search history already have a dedicated repository layer, or
  does it need extraction before cursor migration?
- Should old offset query params remain temporarily for compatibility, or can
  the frontend and backend migrate together in one feature?
