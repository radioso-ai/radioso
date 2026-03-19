# Data Model: Model Token Usage Tracking & Account Summaries

**Feature**: 019-token-usage-ledger | **Date**: 2026-03-19

## New Entity: Usage Event

Immutable record for one model-backed operation.

### Table: `usage_events`

| Field | Type | Constraints / Notes |
| --- | --- | --- |
| id | UUID | PK |
| operation_key | TEXT | UNIQUE, idempotency key for a single provider operation |
| account_id | UUID | NOT NULL, FK -> accounts(id) ON DELETE CASCADE |
| workspace_id | UUID | NULL, FK -> workspaces(id) ON DELETE SET NULL |
| conversation_id | UUID | NULL, attribution only; no cascade dependency required |
| user_message_id | UUID | NULL, attribution only |
| assistant_message_id | UUID | NULL, attribution only |
| document_id | UUID | NULL, attribution only |
| processing_job_id | UUID | NULL, attribution only |
| source_area | TEXT | NOT NULL, e.g. `chat`, `retrieval`, `document_processing` |
| operation_type | TEXT | NOT NULL, e.g. `chat_answer`, `query_rewrite`, `semantic_rerank`, `query_embedding`, `document_embedding` |
| model | TEXT | NOT NULL |
| event_status | TEXT | NOT NULL, e.g. `success`, `failure`, `usage_unavailable` |
| usage_available | BOOLEAN | NOT NULL |
| prompt_tokens | INTEGER | NULL, non-negative |
| completion_tokens | INTEGER | NULL, non-negative |
| total_tokens | INTEGER | NULL, non-negative |
| occurred_at | TIMESTAMPTZ | NOT NULL |
| metadata_json | JSONB | NOT NULL DEFAULT `'{}'::jsonb`, for light attribution/context |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() |

### Relationships

- `accounts 1 -> many usage_events`
- `workspaces 1 -> many usage_events` when the workspace still exists
- Chat/document references are attribution fields rather than authoritative ownership fields

### Validation Rules

| Rule | Layer | Notes |
| --- | --- | --- |
| `operation_key` unique | DB | Prevents duplicate rollup application |
| token counts non-negative when present | Service + DB | No negative values |
| `usage_available = false` implies token counts may be null | Service | Explicitly represents missing provider usage |
| `total_tokens` should equal prompt + completion when both are present | Service | Normalize before persistence |

## New Entity: Account Daily Usage Summary

Persisted account-scoped rollup for a single UTC calendar day.

### Table: `account_daily_usage_summaries`

| Field | Type | Constraints / Notes |
| --- | --- | --- |
| account_id | UUID | PK part, FK -> accounts(id) ON DELETE CASCADE |
| usage_date | DATE | PK part, UTC day bucket |
| prompt_tokens | BIGINT | NOT NULL DEFAULT 0 |
| completion_tokens | BIGINT | NOT NULL DEFAULT 0 |
| total_tokens | BIGINT | NOT NULL DEFAULT 0 |
| usage_event_count | INTEGER | NOT NULL DEFAULT 0 |
| unavailable_event_count | INTEGER | NOT NULL DEFAULT 0 |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() |

### Relationships

- `accounts 1 -> many account_daily_usage_summaries`
- Derived solely from `usage_events`

## Existing Entity Updates

### Chat Conversation Detail (API view model)

Assistant turns gain usage detail in history/debug responses.

| Field | Type | Notes |
| --- | --- | --- |
| debug.usageTotals | object | Turn-level prompt/completion/total token totals |
| debug.usageBreakdown | array | One row per attributable usage event / operation |

### Account Dashboard Route (frontend view model)

Add `usage` to the existing dashboard section union so the account menu can navigate to the account-wide Usage screen while leaving the active workspace untouched.

## Rollup Rules

1. Insert the usage event and update the daily summary in one transaction.
2. If `operation_key` already exists, treat the write as a no-op for both the ledger and the rollup.
3. Only provider-reported token counts contribute to token totals.
4. Events with unavailable usage still increment `usage_event_count`; they also increment `unavailable_event_count`.
5. Monthly summaries are derived by grouping `account_daily_usage_summaries` by calendar month at read time.

## Migration Notes

- Add `usage_events` table plus indexes on `(account_id, occurred_at DESC)`, `(assistant_message_id)`, and `(operation_key)`.
- Add `account_daily_usage_summaries` table with PK `(account_id, usage_date)`.
- No backfill migration is required for pre-existing chats or document-processing history.
