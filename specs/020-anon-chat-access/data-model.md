# Data Model: Anonymous Chat Access

## Schema Changes

### Migration: `009_anonymous_chat.sql`

#### Table: `workspaces` (ALTER)

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `anonymous_chat_enabled` | `BOOLEAN` | `false` | Whether public anonymous chat is active |
| `anonymous_chat_token` | `TEXT` | `NULL` | URL-safe token for the public chat URL (generated on first enable) |
| `anonymous_rate_limit` | `INTEGER` | `10` | Max anonymous messages per session per minute |

#### Table: `conversations` (ALTER)

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `anonymous_session_id` | `TEXT` | `NULL` | Links conversation to an anonymous browser session (NULL for authenticated conversations) |

#### Index

```sql
CREATE INDEX idx_conversations_anonymous_session
  ON conversations (workspace_id, anonymous_session_id)
  WHERE anonymous_session_id IS NOT NULL;
```

## Entity Relationships

```
Workspace (1) ──── (*) Conversation
    │                      │
    │ anonymous_chat_token  │ anonymous_session_id
    │ anonymous_chat_enabled│ source_channel = 'anonymous'
    │                      │
    └──────────────────────┘
         Anonymous sessions are identified by cookie.
         No separate session table — the cookie value
         maps directly to conversations.anonymous_session_id.
```

## Validation Rules

- `anonymous_chat_token` MUST be exactly 22 characters (base64url, 128-bit).
- `anonymous_chat_token` MUST be unique across all workspaces.
- `anonymous_chat_token` is generated only when `anonymous_chat_enabled` transitions from `false` to `true` for the first time (preserved across subsequent toggles).
- `anonymous_session_id` is a UUID v4 string set via cookie.
- When `anonymous_chat_enabled` is `false`, the public route returns 404 regardless of valid token.
- `anonymous_rate_limit` MUST be a positive integer between 1 and 60.
- Rate limiting is enforced per anonymous session (cookie) using an in-memory sliding window counter. No additional database table is needed.

## State Transitions

```
Workspace.anonymous_chat_enabled:
  false (default) ──[admin enables]──> true (token generated if null)
  true ──[admin disables]──> false (token preserved for re-enable)
```

## Cookie Specification

| Property | Value |
|----------|-------|
| Name | `anon_session` |
| Value | UUID v4 |
| HttpOnly | `true` |
| Secure | `true` (production) |
| SameSite | `Lax` |
| Path | `/` |
| Max-Age | 30 days (2592000 seconds) |
