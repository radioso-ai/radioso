# Data Model: Document Search

## Entity: DocumentSearchRequest

- **Purpose**: Represents one live discovery request against the current workspace corpus.
- **Fields**:
  - `workspaceId`
  - `query`
  - `filters`
  - `limit`
  - `cursor` or page token when paging is supported
- **Validation rules**:
  - Query must be non-empty after trimming for live execution.
  - Filters must be bounded to supported fields and metadata constraints.
  - Limit must remain within a bounded maximum suitable for snapshot replay.

## Entity: DocumentSearchResult

- **Purpose**: Represents one ranked document in a live or replayed result page.
- **Fields**:
  - `documentId`
  - `title`
  - `status`
  - `metadata`
  - `score`
  - `rank`
  - `matchEvidence`
  - `availableActions`
  - `snapshotAvailability` for stale/missing downstream actions where applicable
- **Relationships**:
  - Belongs to one `DocumentSearchRun`
  - References one current or formerly matched `Document`
- **Validation rules**:
  - One document appears at most once per result page.
  - Match evidence is bounded and excludes full raw document bodies.

## Entity: DocumentSearchRun

- **Purpose**: The durable identity for one completed live search execution.
- **Fields**:
  - `searchId`
  - `workspaceId`
  - `query`
  - `filters`
  - `resultCount`
  - `createdAt`
  - `replayMode` with values `live` or `snapshot`
  - `traceId`
  - `eventStatus`
- **Relationships**:
  - Owns one `DocumentSearchSnapshot`
  - References one shared `RetrievalTrace`
- **Lifecycle**:
  - Created after successful live search execution
  - Listed through history
  - Reopened later in snapshot mode

## Entity: DocumentSearchSnapshot

- **Purpose**: The stored replay payload for one search run.
- **Fields**:
  - `searchId`
  - `storedResults`
  - `storedSummary`
  - `traceAvailability`
  - `capturedAt`
- **Validation rules**:
  - Stores the exact returned result page, not a recomputed set.
  - Must remain bounded in size.
  - May reference documents that later become unavailable, but replay remains readable.

## Entity: DocumentSearchHistoryEntry

- **Purpose**: Summary record used for history listing.
- **Fields**:
  - `searchId`
  - `query`
  - `createdAt`
  - `resultCount`
  - `traceAvailable`
  - `previewTopTitles`
- **Relationships**:
  - Derived from one `DocumentSearchRun`

## Entity: SharedRetrievalTrace

- **Purpose**: Existing `RetrievalTrace` contract reused for document search.
- **Fields used by this feature**:
  - `traceId`
  - `startedAt`
  - `completedAt`
  - `totalDurationMs`
  - `stages`
  - `links`
  - `summary`
- **Validation rules**:
  - Search runs reuse the existing trace schema.
  - Chat-only stages are marked `skipped` or `unavailable` when non-applicable.
  - Trace remains bounded and excludes secrets, full prompts, and full raw document bodies.

## Relationship Notes

- One live `DocumentSearchRequest` produces one `DocumentSearchRun`.
- One `DocumentSearchRun` persists one `DocumentSearchSnapshot`.
- One `DocumentSearchRun` references one shared `RetrievalTrace`.
- One `DocumentSearchSnapshot` contains many `DocumentSearchResult` entries for the returned page.

## State Notes

- **Live search execution**: request is executed against the current corpus and persists a new run.
- **Historical replay**: stored snapshot is returned by `searchId` without rerunning retrieval.
- **Unavailable downstream action**: individual result actions may degrade if the referenced document has changed or been deleted, but the replayed snapshot remains readable.
