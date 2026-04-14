# Contract Notes: Document External ID

## Existing route surface

This feature intentionally keeps the current document route surface:

- `POST /api/v1/document/`
- `PUT /api/v1/document/:documentId`
- existing read, list, reprocess, delete, and import routes unchanged

No route for reading, listing, or searching by `externalDocumentId` is added.

## Additive request fields

### `POST /api/v1/document/`

Request body gains:

```json
{
  "title": "CRM Article",
  "content": "Updated content",
  "metadata": {
    "source": "crm"
  },
  "externalDocumentId": "crm-123"
}
```

Behavior:

- No `externalDocumentId`: current create semantics
- New `externalDocumentId` in workspace: create document
- Existing `externalDocumentId` in workspace: update same document and queue new revision

Response remains:

```json
{
  "documentId": "uuid",
  "status": "queued"
}
```

The returned `documentId` is always the internal Radioso ID.

### `PUT /api/v1/document/:documentId`

Request body gains the same optional `externalDocumentId` field.

Behavior:

- If the target document has no stored external identity, first assignment is allowed when no other document in the workspace already claims that value
- If the target document already has an external identity, changing it is rejected
- Existing source-kind restrictions remain unchanged

## Additive response fields

The following read/list payloads expose `externalDocumentId` when present:

- `DocumentSummary`
- `DocumentDetails`

Example:

```json
{
  "id": "uuid",
  "title": "CRM Article",
  "status": "ready",
  "ragStatus": "processed",
  "externalDocumentId": "crm-123",
  "metadata": {}
}
```

## Error expectations

### Blank identity

- Status: `400`
- Error shape: existing bad-request format
- Trigger: `externalDocumentId` is empty or whitespace

### Immutable identity conflict

- Status: `409`
- Error shape: existing conflict format
- Trigger: caller attempts to change an already-set external identity

### Tenant-local uniqueness conflict on assignment

- Status: `409`
- Error shape: existing conflict format
- Trigger: caller assigns an `externalDocumentId` already claimed by another document in the same workspace through update-by-ID

## OpenAPI ownership

- Runtime contract source of truth: `backend/src/app/http/openapi/document.ts`
- Generated outputs to refresh after implementation:
  - `backend/openapi.yaml`
  - `backend/openapi.json`
