# Data Model: Model and Embedding Usage Visibility

## Persisted ledger changes

### `usage_events`

| Column | Type | New-row rule | Historical migration rule |
|---|---|---|---|
| `reasoning_tokens` | nullable `BIGINT` | Provider-reported reasoning count for a model call; `0` is a known zero and `NULL` is unavailable. | Always `NULL`; no estimate is created. |
| `event_kind` | non-null `TEXT` constrained to `model`, `embedding`, or `unknown` | `recordModelCall` writes `model`; `recordEmbedding` writes `embedding`. | `model`/`embedding` only with durable evidence; otherwise `unknown`. |

`event_kind` is an event classification, not a label. It does not replace
`surface` or `operation`, which remain the safe product-operation attribution.

The migration may use these existing immutable signals in order to classify
old rows:

1. `idempotency_key` starts with `model:` or `embedding:`.
2. A related `embedding_usage_items` row exists.
3. `vector_count > 0`.

Rows without evidence are `unknown`. The migration neither modifies existing
token counts nor exposes idempotency keys in reporting.

### Indexes

Add an account/time/id keyset index for newest-first internal attempt pages:

```text
usage_events(account_id, occurred_at DESC, id DESC)
```

The existing account/time index remains valid for trends. The detailed-query
implementation must inspect `EXPLAIN` output after adding the new index; add a
message-lineage index only if the group-before-pagination query demonstrably
needs it.

## Derived reporting entities

### Message Usage Summary

A non-persisted row grouped by an end-user message. The grouping predicate is:

```text
usage event joins user message
AND message joins conversation
AND conversation.source_channel NOT IN (authenticated_chat, workbench_replay)
AND usage event surface != eval
```

The row includes safe attribution, `lastOccurredAt`, statuses/quality counts,
and these independent subtotals:

| Subtotal | Fields | Rule |
|---|---|---|
| model | input, completion, reasoning, reasoning coverage, visible output, total | Reasoning coverage considers only model events. `visibleOutput = completion - reasoning` only with complete coverage. |
| embedding | input, total, vector count, attempt count | Has no output/reasoning dimensions. |
| unknown historical | total, attempt count | No model/embedding arithmetic or asserted type. |

### Internal Usage Event

A non-persisted row for one event that does not meet the Message predicate. It
contains occurrence time, workspace ID, durable kind, safe operation label,
provider/model, status, quality, and the dimensions relevant to that kind.
Unknown historical events show as such rather than acquiring guessed fields.

### Cursor

The API encodes opaque base64url JSON and validates its exact shape:

| View | Cursor tuple |
|---|---|
| messages | `lastOccurredAt`, `messageId` |
| internal operations | `occurredAt`, `eventId` |

The tuple is compared descending to match newest-first ordering. Filters are
not embedded as authority; each request revalidates account membership and an
optional workspace scope.
