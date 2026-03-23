# Data Model: Document Import and GCS Storage

## Schema Changes

### `documents` table additions

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `source_kind` | TEXT | NOT NULL | `'inline_text'` | `inline_text` for existing manual docs, `uploaded_file` for imported files |
| `source_filename` | TEXT | YES | `NULL` | Original uploaded filename |
| `source_mime_type` | TEXT | YES | `NULL` | MIME type accepted by the import route |
| `source_storage_bucket` | TEXT | YES | `NULL` | Bucket name used for the stored original file |
| `source_storage_object` | TEXT | YES | `NULL` | Object path/key for the stored original file |
| `source_storage_generation` | TEXT | YES | `NULL` | Optional object generation/version for precise re-read and delete |
| `source_size_bytes` | INTEGER | YES | `NULL` | Uploaded object size for validation and display |

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
  metadata: Record<string, unknown>;
  sourceKind: "inline_text" | "uploaded_file";
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DocumentDetails extends DocumentSummary {
  content: string;
}
```

`content` remains the extracted or authored text available for retrieval and manual inspection. For uploaded files, it is populated after successful processing.

## Supporting Domain Models

### Imported document payload

Represents an accepted upload before processing completes.

| Field | Description |
|-------|-------------|
| `workspaceId` | Owning workspace |
| `title` | User-supplied title override or derived filename title |
| `filename` | Original client filename |
| `mimeType` | Accepted MIME type |
| `sizeBytes` | Raw upload size |
| `storageBucket` | Persisted bucket name |
| `storageObject` | Persisted object key |
| `storageGeneration` | Optional GCS generation |

### Parsed document content

Represents the extracted textual payload returned from `@hivec/document-parser`.

| Field | Description |
|-------|-------------|
| `fileType` | Normalized type (`pdf`, `txt`, `docx`, `xlsx`) |
| `text` | Plain text extraction used for retrieval |
| `markdown` | Normalized markdown/text representation used by chunking |
| `sourceHints` | Optional parser hints such as sheet names or page counts for debugging/logging |

## State Transitions

### Inline text document

- `queued` after manual create/update
- `processing` when a worker claims the current revision
- `ready` after chunk publication succeeds
- `failed` after retries are exhausted

### Uploaded file document

- `queued` after object storage succeeds and the document record is created
- `processing` when a worker claims the current revision and fetches the original object
- `ready` after parsing succeeds, extracted text is persisted, and chunks publish successfully
- `failed` if object read, parse, or chunk processing fails terminally

## Repository/API Rules

- Existing inline-text documents keep `source_kind = 'inline_text'` and null storage columns.
- Imported documents must have `source_kind = 'uploaded_file'` plus non-null filename, MIME type, bucket, object key, and size.
- Reprocess for uploaded files must use the stored object reference instead of the current `source_content` column as the source of truth.
- Delete for uploaded files must succeed only after stored object deletion succeeds, or return a recoverable failure.

## Migration Shape

```sql
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'inline_text',
  ADD COLUMN IF NOT EXISTS source_filename TEXT,
  ADD COLUMN IF NOT EXISTS source_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS source_storage_bucket TEXT,
  ADD COLUMN IF NOT EXISTS source_storage_object TEXT,
  ADD COLUMN IF NOT EXISTS source_storage_generation TEXT,
  ADD COLUMN IF NOT EXISTS source_size_bytes INTEGER;
```

The migration is additive and backward-compatible with existing documents.
