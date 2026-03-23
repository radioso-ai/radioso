# Data Model: Ingestion Settings Controls

## Ingestion Settings

- **Represents**: The workspace-scoped configuration used when documents are prepared for retrieval.
- **Key fields**:
  - workspace identifier
  - chunking strategy
  - fixed-window chunk size
  - fixed-window chunk overlap
  - structured minimum chunk size
  - structured maximum chunk size
  - created timestamp
  - updated timestamp
- **Validation rules**:
  - chunking strategy must be one of the supported strategy identifiers
  - fixed-window chunk size must be within the supported numeric range
  - fixed-window chunk overlap must be non-negative and strictly smaller than fixed-window chunk size
  - structured minimum chunk size must be within the supported numeric range
  - structured maximum chunk size must be within the supported numeric range
  - structured minimum chunk size must be less than or equal to structured maximum chunk size

## Ingestion Settings Defaults

- **Represents**: The baseline settings assigned to workspaces that have never saved ingestion settings.
- **Key fields**:
  - default chunking strategy derived from current production behavior
  - default fixed-window chunk size and overlap derived from existing constants
  - default structured minimum and maximum chunk sizes derived from existing constants
- **Rules**:
  - defaults must preserve current behavior for workspaces that do not actively change settings
  - defaults must be applied consistently on reads and initial inserts

## Retrieval Settings

- **Represents**: Workspace-scoped query, rerank, citation, attribute-control, and answer-instruction settings after chunking controls are removed.
- **Key fields**:
  - workspace identifier
  - query rewrite flag
  - rerank flag
  - vector candidate count
  - similarity threshold
  - rerank candidate count
  - warmth level
  - citation-display flag
  - attribute controls
  - custom instruction
- **Rules**:
  - retrieval settings remain independent from ingestion settings
  - migration must preserve current retrieval values while removing chunking ownership from this model

## Workspace Reprocess Request

- **Represents**: An operator-initiated command to re-queue existing documents in a workspace so they can be rebuilt under the current ingestion settings.
- **Key fields**:
  - workspace identifier
  - eligible document count
  - skipped document count
  - initiation timestamp
- **Rules**:
  - only bearer-authenticated operators with workspace context can create the request
  - documents already queued or processing are skipped to avoid duplicate jobs
  - the action is explicit and separate from ingestion settings save

## Reprocess Result

- **Represents**: The response returned after a workspace bulk reprocess action is accepted.
- **Key fields**:
  - workspace identifier
  - queued document count
  - skipped document count
  - resulting status summary
- **Rules**:
  - result must let the UI explain whether documents were queued or already in flight
  - a repeated request during active processing should remain safe and should not create duplicate queued work

## Document Eligibility Snapshot

- **Represents**: The set of existing documents inspected during a workspace reprocess action.
- **Key fields**:
  - document identifier
  - current document status
  - current revision
  - current updated timestamp
- **Rules**:
  - ready and failed documents are eligible for immediate re-queue
  - queued and processing documents are skipped in the current design
  - deleted documents are naturally excluded by repository lookup
