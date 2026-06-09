# Contract: Account Usage Trends

## GET `/api/v1/account/usage-trends`

Session-authenticated endpoint. Requires an active membership in the session account.

### Query Parameters

| Name | Required | Type | Notes |
| ---- | -------- | ---- | ----- |
| `from` | yes | `YYYY-MM-DD` | Inclusive UTC date |
| `to` | yes | `YYYY-MM-DD` | Inclusive UTC date |
| `granularity` | yes | `day \| week \| month` | UTC bucket boundaries |
| `workspaceId` | no | UUID | Must belong to the session account |
| `agentId` | no | UUID | Must belong to the session account |

Requests producing more than 366 buckets return `400`.

### 200 Response

```json
{
  "granularity": "day",
  "from": "2026-06-01",
  "to": "2026-06-03",
  "filters": {
    "workspaceId": null,
    "agentId": null
  },
  "buckets": [
    {
      "periodStart": "2026-06-01T00:00:00.000Z",
      "periodEnd": "2026-06-02T00:00:00.000Z",
      "conversationsCreated": 2,
      "messages": {
        "total": 6,
        "user": 3,
        "assistant": 3
      },
      "tokens": {
        "input": 1200,
        "output": 800,
        "total": 2000
      }
    }
  ]
}
```

### Error Responses

- `400`: invalid date, invalid granularity, `from > to`, too many buckets, or invalid/cross-account workspace or agent filter.
- `401`: missing/invalid session or no active membership.

### Attribution Notes

Token totals include only `usage_events.status = 'succeeded'`.

When `agentId` is supplied, token totals include only usage events that can be joined to a conversation with that agent. Usage events without a conversation are excluded from agent-filtered token totals.

The response contains aggregate counts only. It never returns message content, prompts, completions, retrieved chunks, or document content.
