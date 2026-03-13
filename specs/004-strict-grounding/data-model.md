# Data Model: Strict Grounding

## Retrieval Settings

- **Purpose**: Defines account-scoped chat retrieval behavior.
- **Key fields**:
  - `accountId`
  - `queryRewriteEnabled`
  - `rerankEnabled`
  - `vectorTopK`
  - `similarityThreshold`
  - `rerankTopK`
- **Rules**:
  - `similarityThreshold` is the minimum similarity allowed for answer-supporting
    candidates.
  - `vectorTopK` controls the size of the first-pass candidate pool.
  - Stored values remain authoritative for accounts that already have a settings
    record.

## Retrieved Candidate

- **Purpose**: Represents a retrieved chunk that can be considered for final
  prompt context.
- **Key fields**:
  - `chunkId`
  - `documentId`
  - `title`
  - `content`
  - `similarity`
  - `relevanceScore`
  - `retrievalSources`
- **Rules**:
  - Candidates below the configured similarity floor are excluded from the
    grounded answer path.
  - Reranking may reorder admitted candidates but does not create new ones.

## Chat Answer Outcome

- **Purpose**: Captures the user-visible result of a chat request.
- **Variants**:
  - Grounded answer with citations
  - Safe refusal when grounded context is insufficient
- **Rules**:
  - A safe refusal is returned when no admitted candidate survives the threshold
    policy strongly enough to support an answer.
  - The transport shape remains unchanged regardless of outcome.
