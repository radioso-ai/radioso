# Ingestion Settings Contract

## Purpose

Define the planned HTTP contract split between retrieval settings and ingestion settings, plus the workspace-level reprocess action initiated from the Ingestion tab. Runtime source of truth remains the code-first OpenAPI registry in [document.ts](/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/http/openapi/document.ts).

## Retrieval Settings After Split

- `GET /api/v1/settings/retrieval`
  - Returns retrieval-only fields:
    - workspaceId
    - queryRewriteEnabled
    - rerankEnabled
    - vectorTopK
    - similarityThreshold
    - rerankTopK
    - warmthLevel
    - citationDisplayEnabled
    - attributeControls
    - customInstruction
- `PUT /api/v1/settings/retrieval`
  - Accepts and updates the same retrieval-only fields
  - No longer accepts `chunkingStrategy`

## Ingestion Settings

- `GET /api/v1/settings/ingestion`
  - Returns:
    - workspaceId
    - chunkingStrategy
    - fixedWindowChunkSize
    - fixedWindowChunkOverlap
    - structuredMinChunkSize
    - structuredMaxChunkSize
    - createdAt
    - updatedAt
- `PUT /api/v1/settings/ingestion`
  - Accepts:
    - chunkingStrategy
    - fixedWindowChunkSize
    - fixedWindowChunkOverlap
    - structuredMinChunkSize
    - structuredMaxChunkSize
  - Validation expectations:
    - supported strategy only
    - numeric bounds enforced
    - overlap must remain smaller than fixed-window chunk size
    - structured minimum must not exceed structured maximum

## Workspace Reprocess Action

- `POST /api/v1/settings/ingestion/reprocess`
  - Workspace-scoped action triggered from the Ingestion tab
  - Returns:
    - workspaceId
    - queuedDocumentCount
    - skippedDocumentCount
    - status
  - Behavior:
    - queues eligible existing documents for reprocessing under the current ingestion settings
    - skips documents already `queued` or `processing`
    - remains safe to call again while prior queued work is still in flight

## OpenAPI Ownership Notes

- Request and response schemas must be declared in `backend/src/app/http/openapi/document.ts`.
- `backend/openapi.yaml` and `backend/openapi.json` must be regenerated after runtime schema changes.
- Contract tests should assert:
  - retrieval settings no longer include `chunkingStrategy`
  - ingestion settings include the new chunking and size fields
  - workspace reprocess action is documented and returns the expected shape
