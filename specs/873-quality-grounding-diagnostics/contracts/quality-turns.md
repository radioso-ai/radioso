# Contract: Quality Turn Grounding Diagnostics

## `GET /api/v1/quality/turns`

### Query parameters

- `groundingVerdict`: comma-separated or repeated values from `grounded`,
  `degraded`, `no_support`. Values are ORed.
- `hasUnsourcedClaims`: strict `true` or `false`.
- `hasInvalidSources`: strict `true` or `false`.

The three groups are ANDed with each other and every existing Quality filter.
Invalid values return the existing `400` invalid-quality-query response.

### Response addition

Each item includes `grounding`.

```json
{
  "grounding": {
    "verdict": "degraded",
    "claimCount": 3,
    "sourcedClaimCount": 2,
    "unsourcedClaimCount": 1,
    "invalidSourceCount": 0
  }
}
```

When no complete persisted snapshot exists:

```json
{ "grounding": null }
```

Partial objects and fabricated zeroes are not valid responses.

### Compatibility

This is an additive response field and additive optional query parameters.
Authorization, workspace isolation, pagination, totals, ordering, and error shape
are unchanged.

## Code-first ownership

Runtime schema/path ownership:

- `backend/src/app/http/openapi/schemas/qualitySchemas.ts`
- `backend/src/app/http/openapi/paths/qualityPaths.ts`

Generated:

- `backend/openapi.json`
- `backend/openapi.yaml`
- TypeScript SDK snapshots/types
- MCP OpenAPI types

## Message-queue impact

None. No document-worker dispatch, AMQP payload, retry behavior, queue test, or
queue documentation changes.
