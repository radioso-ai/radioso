# Contract Notes: Retrieval Signal Policies

## `GET /api/v1/settings/retrieval`

- Returns the workspace retrieval settings payload with `signalPolicies` instead of `attributeControls`.
- Existing fields for query rewrite, rerank, vector tuning, warmth, citations, and custom instruction remain unchanged.
- Response remains workspace-scoped and bearer-authenticated.

### Response shape

- `queryRewriteEnabled`
- `rerankEnabled`
- `vectorTopK`
- `similarityThreshold`
- `rerankTopK`
- `warmthLevel`
- `citationDisplayEnabled`
- `customInstruction`
- `signalPolicies[]`
  - `signalKey`
  - `valueType`
  - `enabled`
  - `mode`

## `PUT /api/v1/settings/retrieval`

- Accepts the same top-level retrieval settings fields as `GET`, with optional `signalPolicies` and `customInstruction`.
- If `signalPolicies` is omitted, the service preserves the existing policies for that workspace.
- Validation rejects duplicate signal keys, unsupported value types, unsupported modes, and malformed policy entries.

## Compatibility behavior

- Legacy persisted `attribute_controls` rows are translated into the new `signalPolicies` payload on read.
- New writes persist the new `signalPolicies` representation.
- The runtime contract and generated OpenAPI outputs treat `signalPolicies` as the only public representation after this feature.
