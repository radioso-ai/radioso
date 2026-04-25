# Social Turn Routing Contract Notes

This feature does **not** add a new public HTTP endpoint.

It does introduce two additive internal contracts that reviewers should keep
stable:

## 1. Query Interpretation Output

The structured interpretation result emitted by the existing query rewrite
model pass gains an additive field:

- `responseIntent`: `retrieval | social_only | assistant_identity`

Compatibility rules:

- Missing or malformed `responseIntent` falls back to `retrieval`.
- Existing retrieval rewrite fields remain required for retrieval-backed turns.
- Mixed turns must still emit `responseIntent: "retrieval"` even when the text
  contains politeness or social language.

## 2. Stored Chat Diagnostics

Assistant-turn metadata gains additive routing fields:

- `responseIntent`
- `retrievalSkipped`
- `intentConfidence` when available
- `intentFallbackApplied` when the system had to preserve the normal retrieval
  path because intent output was unusable

Compatibility rules:

- Existing chat response payloads remain backward-compatible.
- Existing audit and history/debug readers must tolerate the absence of the new
  fields for older turns.
