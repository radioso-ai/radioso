# HTTP Contract Notes: Date-Aware Event Retrieval

Code-first OpenAPI remains the source of truth. Update runtime Zod schemas and
OpenAPI registry modules together, then regenerate artifacts during
implementation.

## Settings: Ingestion

### `GET /api/v1/settings/ingestion`

Add response field:

```json
{
  "documentEnrichmentEnabled": false
}
```

### `PUT /api/v1/settings/ingestion`

Add request field:

```json
{
  "documentEnrichmentEnabled": true
}
```

Target files:
- `backend/src/app/http/routes/settingsRouteSchemas.ts`
- `backend/src/app/http/openapi/schemas/settingsSchemas.ts`
- `backend/src/app/http/openapi/paths/settingsPaths.ts`

## Documents: Sources

### `GET /api/v1/document/sources`

Add source list item field:

```json
{
  "documentEnrichmentOverride": "inherit"
}
```

### `PATCH /api/v1/document/sources/{sourceId}`

Add request field:

```json
{
  "documentEnrichmentOverride": "on"
}
```

Values: `inherit`, `on`, `off`.

Target files:
- `backend/src/app/http/routes/documentRouteSchemas.ts`
- `backend/src/app/http/presenters/documentSourcePresenter.ts`
- `backend/src/app/http/openapi/paths/documentsPaths.ts`

## Documents: Reprocess

### `POST /api/v1/document/{documentId}/reprocess`

Add optional request body:

```json
{
  "documentEnrichmentOverride": "off"
}
```

Values: `on`, `off`.

### `POST /api/v1/settings/ingestion/reprocess`

Add optional request body with same override shape for workspace reprocess.

### `POST /api/v1/document/sources/{sourceId}/reprocess`

New endpoint. Request:

```json
{
  "documentEnrichmentOverride": "on"
}
```

Response:

```json
{
  "sourceId": "uuid",
  "workspaceId": "uuid",
  "queuedDocumentCount": 12,
  "skippedDocumentCount": 3,
  "status": "queued"
}
```

Status values: `queued`, `noop`.

## Documents: Detail

### `GET /api/v1/document/{documentId}`

Add enrichment provenance for operator visibility:

```json
{
  "enrichment": {
    "status": "applied",
    "shape": "event",
    "model": "gpt-5.2",
    "enrichedAt": "2026-07-02T00:00:00.000Z",
    "anchorDate": "2026-07-02",
    "anchorSource": "source_last_sync",
    "factCount": 2,
    "appliedChunkCount": 4,
    "failureReason": null
  }
}
```

## Retrieval Skill Settings

Add flat fields to `RetrievalSettingsOverride`,
`RetrievalDefaultsResponse`, generated skill contract, and frontend
serialization:

```json
{
  "temporalStructuredLookupEnabled": true,
  "temporalBoostUpcomingEnabled": true,
  "temporalDeterministicSortEnabled": true
}
```

Target files:
- `backend/src/modules/settings/domain/retrievalSettings.ts`
- `backend/src/modules/retrieval/domain/retrievalSkillSettings.ts`
- `backend/src/modules/skills/definitions/retrieval.answer/generated.contract.json`
- `frontend/lib/retrieval-skill-settings.ts`

## Generated Downstream Artifacts

Implementation must regenerate, not hand-edit:
- `backend/openapi.yaml`
- `backend/openapi.json`
- `typescript-sdk/openapi/radioso.yaml`
- `typescript-sdk/openapi/radioso.json`
- `typescript-sdk/src/generated/types.ts`
- `typescript-sdk/src/generated/client.ts`
- `packages/radioso-mcp-server/src/generated/openapiTypes.ts`

## Queue Contract

No HTTP contract changes require AMQP message changes. Reprocess overrides live
on `document_processing_jobs.options`. `DocumentJobQueueMessage` remains
unchanged.
