# Data Model: Selectable Chunking Strategies

## 1. Retrieval Settings

Account-scoped configuration used by retrieval and document-ingest behavior.

### Fields

- `accountId`: Unique account identifier
- `queryRewriteEnabled`: Existing retrieval preference
- `rerankEnabled`: Existing retrieval preference
- `vectorTopK`: Existing retrieval preference
- `similarityThreshold`: Existing retrieval preference
- `rerankTopK`: Existing retrieval preference
- `warmthLevel`: Existing response preference
- `citationDisplayEnabled`: Existing response preference
- `chunkingStrategy`: Selected chunking behavior for future document ingests and updates
- `createdAt`: Creation timestamp
- `updatedAt`: Last update timestamp

### Validation Rules

- `chunkingStrategy` must be one of the supported strategy identifiers
- Accounts without an explicit stored strategy default to `fixed_window`
- Existing retrieval settings validation rules remain unchanged

### Notes

- `chunkingStrategy` is account-scoped and shared across all document ingests for that account
- A changed `chunkingStrategy` affects future document ingests and updates only; it does not rewrite already stored chunk sets

## 2. Chunking Strategy

Named ingest behavior that produces ordered retrieval chunks through a shared interface.

### Fields

- `id`: Stable strategy identifier
- `label`: Operator-facing name shown in Settings
- `description`: Plain-language explanation of how the strategy behaves
- `appliesTo`: Future document ingests and document updates for the owning account

### Validation Rules

- `id` is unique across supported strategies
- One strategy is marked as the default for accounts without an explicit selection

### Allowed Values In This Feature

- `fixed_window`: Existing overlapping fixed-window behavior
- `structured_semantic`: Deterministic structure-aware chunking with adjacent semantic merging and structure-only fallback

## 3. Structural Block Unit

Deterministic source segment used as input to the structure-aware chunking strategy.

### Fields

- `kind`: Structural category such as paragraph, heading section, bullet list, numbered step group, table, code fence, or FAQ pair
- `content`: Ordered source content represented by the block
- `startOffset`: Inclusive source start position
- `endOffset`: Exclusive source end position
- `sequence`: Source-order position within the document

### Validation Rules

- Blocks preserve original source order
- Offsets must be monotonic and non-overlapping
- `content` must not be empty

### Notes

- Structural block units are internal to the structured strategy and are not persisted directly in this feature
- FAQ pairs are modeled as deterministic grouped content rather than inferred from English-specific regex rules

## 4. Chunk Boundary Decision

Decision record used by the structured strategy to either merge the next adjacent block into the current chunk or start a new chunk.

### Fields

- `currentChunkBlocks`: Ordered block units already grouped into the current chunk candidate
- `nextBlock`: The adjacent structural block unit being evaluated
- `mergeReason`: Structure continuity, semantic continuity, or size-bound limit
- `decision`: Merge or split

### Validation Rules

- Decisions only compare adjacent block units or chunk candidates in source order
- A split is required when adding the next block would violate maximum chunk size
- A split may occur before maximum size when a topic change is detected

## 5. Stored Chunk Set

Persisted chunk records for one document at the time of ingest.

### Fields

- `documentId`: Owning document identifier
- `accountId`: Owning account identifier
- `chunkIndex`: Ordered persisted chunk position
- `content`: Stored chunk text
- `embedding`: Retrieval embedding for the stored chunk
- `startOffset`: Inclusive source start position
- `endOffset`: Exclusive source end position
- `createdAt`: Persistence timestamp

### Validation Rules

- `chunkIndex` is unique within one document
- Stored chunks preserve source order
- No empty chunks are persisted
- All persisted chunks respect the active strategy’s bounded chunk-size guarantees

### Notes

- Existing chunk persistence shape remains compatible with retrieval and citation behavior
- The persisted chunk set reflects whichever chunking strategy was active when the document was last ingested or updated

## 6. State Transitions

### Retrieval Settings

1. Defaults created or loaded for an account
2. Operator retrieves settings
3. Operator saves a supported `chunkingStrategy`
4. Updated setting is returned and used for future document ingest operations

### Document Ingest With Strategy Selection

1. Document create or update request received
2. Account retrieval settings loaded
3. Active chunking strategy resolved from `chunkingStrategy`
4. Source content normalized
5. Strategy produces ordered chunk outputs
6. Embeddings generated for produced chunks
7. Stored chunk set replaced for the document
8. Document status advances to ready or failed
