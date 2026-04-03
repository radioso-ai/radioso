# Data Model Notes: High-Cardinality Cursor Hardening

## Collection Cursor

- Opaque string token
- Encodes:
  - collection type or version
  - primary sort timestamp
  - stable row id tie-breaker

## Collection Window Response

- `items`
- `nextCursor`
- `hasMore`
- optional `total` during migration where still needed by existing UI

## Collection Sort Keys

### Documents

- Sort: `created_at DESC, id DESC`
- Window entity: document summary only

### Authenticated Conversation History

- Sort: `updated_at DESC, id DESC`
- Window entity: conversation summary only

### Anonymous Conversation History

- Sort: `updated_at DESC, id DESC`
- Scoped by `workspace_id` and `anonymous_session_id`

### Conversation Message History

- Sort for storage traversal: `created_at DESC, id DESC`
- Presentation order: chronological in UI after bounded window retrieval

### Document Search History

- Sort: recency plus stable id tie-breaker
- Window entity: search-history summary only

## Index Expectations

- Documents: composite index aligned with `(workspace_id, created_at DESC, id DESC)`
- Conversations: composite index aligned with `(workspace_id, updated_at DESC, id DESC)`
- Anonymous conversations: composite index aligned with `(workspace_id, anonymous_session_id, updated_at DESC, id DESC)`
- Messages: composite index aligned with `(conversation_id, created_at DESC, id DESC)`

## Invalid Cursor Handling

- Malformed token: client-visible validation error
- Wrong collection type/version: client-visible validation error
- Stale cursor after underlying deletes: either return the next valid window or
  fail safely, but never fall back to an unbounded scan
