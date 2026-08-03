# Usage Details API Contract

These dashboard resources use the existing browser session cookie. They are
registered in the backend's code-first OpenAPI registry and are deliberately
not added to the API-key TypeScript SDK.

## Shared query

```text
from=YYYY-MM-DD        required, inclusive UTC day
to=YYYY-MM-DD          required, inclusive UTC day
workspaceId=<uuid>     optional, must belong to the active account
limit=1..100           optional, defaults to 50
cursor=<opaque>        optional, view-specific keyset cursor
```

The maximum date range is 90 days. Invalid dates, ranges, cursors, limits, and
cross-account workspaces return the standard `400` response. Missing/expired
sessions return `401`.

## `GET /api/v1/account/usage/messages`

Returns one newest-first row per qualifying end-user message after complete
aggregation, with `nextCursor` when another group exists.

```json
{
  "from": "2026-07-01",
  "to": "2026-07-30",
  "filters": { "workspaceId": null },
  "items": [
    {
      "messageId": "6a750ab5-d129-43ca-903d-af0f3b7d092d",
      "workspaceId": "bce502a9-7807-44c7-b28d-1311bfe4fb2f",
      "lastOccurredAt": "2026-07-30T12:01:00.000Z",
      "providers": ["openai"],
      "models": ["gpt-5"],
      "operations": [{ "surface": "assistant", "name": "answer", "label": "Answer" }],
      "attempts": { "total": 2, "succeeded": 2, "failed": 0 },
      "quality": { "actual": 2, "estimated": 0 },
      "modelTokens": {
        "input": 120,
        "completion": 40,
        "reasoning": { "tokens": 12, "coverage": "complete" },
        "visibleOutput": 28,
        "total": 160
      },
      "embeddingTokens": { "input": 9, "total": 9, "vectors": 1, "attempts": 1 },
      "unknownHistorical": { "total": 0, "attempts": 0 }
    }
  ],
  "nextCursor": null
}
```

`reasoning.coverage` is `complete`, `partial`, or `unavailable`. A partial or
unavailable value has `visibleOutput: null`; `completion` remains the raw
provider-reported completion total and may include reasoning.

## `GET /api/v1/account/usage/internal-operations`

Returns one newest-first ledger event per row, with `nextCursor` when another
attempt exists.

```json
{
  "from": "2026-07-01",
  "to": "2026-07-30",
  "filters": { "workspaceId": null },
  "items": [
    {
      "eventId": "a08099e4-36b9-46db-ab85-3693b4db53ec",
      "workspaceId": "bce502a9-7807-44c7-b28d-1311bfe4fb2f",
      "occurredAt": "2026-07-30T12:02:00.000Z",
      "kind": "embedding",
      "operation": {
        "surface": "documents",
        "name": "document_enrichment",
        "label": "Metadata generation"
      },
      "provider": "openai",
      "model": "text-embedding-3-small",
      "status": "succeeded",
      "usageQuality": "actual",
      "tokens": {
        "input": 100,
        "completion": null,
        "reasoning": null,
        "visibleOutput": null,
        "total": 100
      },
      "vectorCount": 1
    }
  ],
  "nextCursor": null
}
```

For a model event, `vectorCount` is `null`; reasoning/visible-output follow
the same availability rule as a single model record. Unknown historical events
have only their safe common dimensions and a `kind` of `unknown`.

## Privacy allowlist

The response may contain only fields documented above. It never includes
message content, prompts, completions, document/chunk content, credentials,
cookies, connection strings, idempotency keys, provider request IDs, error
codes, or error text.
