# Data Model: External Document ID

## Schema Changes

### `documents` table additions

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `external_document_id` | TEXT | YES | `NULL` | Optional immutable upstream identity scoped to one workspace |

### Indexes and constraints

| Name | Shape | Purpose |
|------|-------|---------|
| `idx_documents_workspace_external_document_id_unique` | `UNIQUE (workspace_id, external_document_id) WHERE external_document_id IS NOT NULL` | Prevent duplicate external identities inside one workspace while allowing reuse across workspaces |

## Type Changes

### `DocumentRecord`

```typescript
interface DocumentRecord {
  id: string;
  workspaceId: string;
  title: string;
  sourceContent: string;
  markdownContent: string;
  status: string;
  revision: number;
  failureReason?: string | null;
  metadata: Record<string, unknown>;
  externalDocumentId?: string | null;
  sourceKind: "inline_text" | "uploaded_file";
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
  sourceStorageBucket?: string | null;
  sourceStorageObject?: string | null;
  sourceStorageGeneration?: string | null;
  sourceSizeBytes?: number | null;
  createdAt: Date;
  updatedAt: Date;
}
```

### `DocumentSummary` / `DocumentDetails`

```typescript
interface DocumentSummary {
  id: string;
  title: string;
  status: string;
  ragStatus: "processed" | "pending";
  failureReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  externalDocumentId?: string | null;
  sourceKind: "inline_text" | "uploaded_file";
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
}

interface DocumentDetails extends DocumentSummary {
  content: string;
}
```

### Write payloads

```typescript
interface DocumentWritePayload {
  title: string;
  content: string;
  metadata?: Record<string, string | number | boolean | null>;
  externalDocumentId?: string;
}
```

## Supporting Domain Models

### External document identity

| Field | Description |
|-------|-------------|
| `workspaceId` | Tenant boundary for uniqueness and idempotency |
| `externalDocumentId` | Opaque caller-supplied upstream identity |
| `documentId` | Canonical internal UUID for the bound Radioso document |

## State and write rules

### Create without external identity

- Create a new document record with a generated UUID
- Preserve current non-idempotent behavior for repeated writes

### Create with external identity

- If the workspace has no matching `external_document_id`, create a new document with a generated UUID
- If the workspace already has a matching `external_document_id`, update that same document and queue a new revision

### Update by internal document ID

- If the document has no stored `external_document_id`, first assignment of `externalDocumentId` is allowed when the workspace does not already claim it
- If the document already has a stored `external_document_id`, any attempt to change the value is rejected
- Existing source-kind restrictions continue to block inline mutation of imported-file documents

## Repository/API Rules

- Internal `documents.id` remains the only relational key used by chunks, processing jobs, deletion, and existing routes.
- `externalDocumentId` is optional and additive; omitted values do not alter current create semantics.
- The system must never return two documents in the same workspace with the same `externalDocumentId`.
- The same `externalDocumentId` value may appear in different workspaces.
- Read/list/delete/reprocess flows continue to use internal `documentId`; no new query-by-external-ID contract is introduced.

## Migration Shape

```sql
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS external_document_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_workspace_external_document_id_unique
  ON documents (workspace_id, external_document_id)
  WHERE external_document_id IS NOT NULL;
```

The migration is additive and backward-compatible for existing documents that do not use external identity.
