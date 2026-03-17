# Data Model: Async Document Processing

## Document

Represents the latest accepted source content for a knowledge-base document.

### Fields

- `id`: stable document identifier
- `accountId`: owning account
- `title`: latest accepted title
- `sourceContent`: latest accepted source content
- `markdownContent`: normalized content used during processing
- `status`: `queued | processing | ready | failed`
- `revision`: monotonically increasing accepted revision number
- `failureReason`: nullable user-safe terminal failure description
- `createdAt`
- `updatedAt`
- `failedAt`

### State Transitions

- `queued` after create, update, or explicit reprocess acceptance
- `processing` after a worker claims the current revision job
- `ready` after successful processing publishes chunks for the current revision
- `failed` after the current revision exhausts retries or hits a terminal error

## Document Processing Job

Represents durable background work for one document revision.

### Fields

- `id`: stable job identifier
- `documentId`: owning document
- `accountId`: owning account
- `documentRevision`: revision this job is allowed to publish
- `status`: `queued | processing | completed | failed | skipped`
- `attemptCount`: number of claims attempted
- `lastError`: nullable error summary
- `availableAt`: next time the job may be claimed
- `claimedAt`: nullable claim timestamp
- `completedAt`: nullable terminal timestamp
- `createdAt`
- `updatedAt`

### Rules

- At most one active job should exist per document revision.
- A completed job may publish results only if its `documentRevision` still matches the document's current `revision`.
- A skipped job records stale or deleted-document outcomes without publishing chunks.

## Processed Retrieval Content

Represents the chunk rows stored for retrieval.

### Rules

- Chunk rows are replaced only for the latest current revision.
- Retrieval remains scoped to documents with `ready` status because only successful current revisions publish chunk rows.
- Failed or skipped revisions must not publish new chunks.
