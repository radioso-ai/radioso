# Contract Notes: Document Search

## Purpose

This feature adds a first-class document discovery contract with replayable history and shared retrieval diagnostics while preserving the existing plain document browse contract.

## Contract Ownership

- Backend HTTP schema changes are owned by `backend/src/app/http/openapi/document.ts`.
- Generated `backend/openapi.yaml` and `backend/openapi.json` remain outputs and must not be hand-edited.
- Frontend API types in `frontend/lib/api.ts` must stay aligned with the runtime Zod-backed schemas.

## Additive Runtime Contract Changes

### Live Search

- Add a dedicated search execution endpoint under the existing document route group.
- Request shape design intent:
  - `query`
  - optional `filters`
  - optional paging controls
- Response shape design intent:
  - `searchId`
  - search summary
  - ranked `results`
  - `retrievalTrace` or trace availability reference
  - explicit `noResults` semantics distinct from errors

### Search History List

- Add a dedicated history-list endpoint for prior document searches in the active workspace.
- Response shape design intent:
  - `searches`
  - each item includes `searchId`, `query`, `createdAt`, `resultCount`, and trace availability

### Search Replay

- Add a dedicated replay endpoint for one prior document search by `searchId`.
- Response shape design intent:
  - `searchId`
  - stored summary
  - stored ranked result page
  - replay mode marker showing this is a stored snapshot
  - shared `retrievalTrace` or explicit unavailable state

## Backward-Compatibility Rules

- `GET /api/v1/document/` remains plain browsing and must not become ranked search.
- Existing document CRUD contracts remain unchanged except for additive search/history routes.
- Clients that do not use document search are unaffected.

## Snapshot Rules

- Replay returns the stored result page from the original search execution.
- Fresh rerun of the same query is a separate new search request, not a silent replay behavior.
- Missing documents after the original search do not invalidate the replay payload; only downstream actions degrade.

## Trace Rules

- Document search reuses the existing `RetrievalTrace` contract.
- Chat-only stages may appear as `skipped` or `unavailable`.
- No parallel top-level trace schema should be introduced for this feature.

## Action Rules

Guaranteed v1 result actions:

- open document
- inspect match evidence
- open diagnostics/history entry
- rerun the same query as a fresh new search

Out of scope for v1:

- direct search-to-chat pivot constrained to one document or result set
