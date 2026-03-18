# Data Model: Document Metadata

## Schema Changes

### documents table

| Column   | Type  | Nullable | Default | Notes                    |
|----------|-------|----------|---------|--------------------------|
| metadata | JSONB | NOT NULL | '{}'    | Arbitrary key-value pairs |

### chunks table

| Column   | Type  | Nullable | Default | Notes                                   |
|----------|-------|----------|---------|------------------------------------------|
| metadata | JSONB | NOT NULL | '{}'    | Copied from parent document at ingestion |

### Indexes

| Table  | Index                        | Type | Purpose                          |
|--------|------------------------------|------|----------------------------------|
| documents | idx_documents_metadata    | GIN  | Containment queries on metadata  |
| chunks    | idx_chunks_metadata       | GIN  | Pre-filter during retrieval      |

## Type Changes

### DocumentRecord

```typescript
interface DocumentRecord {
  // ... existing fields ...
  metadata: Record<string, unknown>;  // NEW
}
```

### ChunkRecord

```typescript
interface ChunkRecord {
  // ... existing fields ...
  metadata: Record<string, unknown>;  // NEW
}
```

### RetrievedChunk

```typescript
interface RetrievedChunk {
  // ... existing fields ...
  metadata?: Record<string, unknown>;  // NEW
}
```

## Migration: 006_document_metadata.sql

```sql
ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_documents_metadata ON documents USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_chunks_metadata ON chunks USING GIN (metadata);
```

Fully idempotent — safe to re-run.

## Example metadata values

```json
{
  "sourceUrl": "https://example.com/docs/guide",
  "language": "en",
  "author": "Jane Doe",
  "category": "technical",
  "version": "2.1"
}
```
