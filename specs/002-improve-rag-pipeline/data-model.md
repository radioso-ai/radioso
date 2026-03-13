# Data Model: Universal Retrieval Quality Upgrade

## Overview

This feature keeps the public API contract unchanged and introduces stronger internal retrieval-state handling. Most additions are transient runtime models or richer execution metadata rather than new externally visible resources.

## Entities

### Retrieval Settings Profile

- **Purpose**: Account-scoped controls for retrieval preparation, candidate depth, thresholding, and final-context selection
- **Current Source**: Existing retrieval settings store
- **Fields**:
  - `accountId`
  - `queryRewriteEnabled`
  - `rerankEnabled`
  - `vectorTopK`
  - `similarityThreshold`
  - `rerankTopK`
- **Validation Rules**:
  - `vectorTopK` remains bounded by existing settings validation
  - `similarityThreshold` remains within the configured minimum/maximum range
  - `rerankTopK` must remain positive and must not exceed the available candidate count at runtime

### Conversation Context Window

- **Purpose**: The bounded subset of conversation history used for retrieval preparation
- **Lifecycle**: Derived at request time from stored conversation messages
- **Fields**:
  - `conversationId`
  - `selectedMessages`
  - `selectionReason`
  - `truncated`
- **Rules**:
  - Must prefer the most recent turns needed to resolve referential queries
  - Must remain bounded so rewrite and answer prompts do not receive the full raw conversation by default

### Rewritten Retrieval Query

- **Purpose**: Retrieval-only standalone query derived from the latest user message and conversation context
- **Lifecycle**: Derived per request; not required to persist as a separate runtime record
- **Fields**:
  - `sourceQuery`
  - `rewrittenQuery`
  - `rewriteApplied`
  - `rewriteConfidence`
  - `fallbackReason`
- **Rules**:
  - Must preserve original intent
  - Must not introduce unsupported facts
  - Must be safe to discard in favor of the original query

### Retrieved Candidate

- **Purpose**: Normalized first-pass retrieval result eligible for reranking and final selection
- **Lifecycle**: Derived after vector search and normalized before reranking
- **Fields**:
  - `chunkId`
  - `documentId`
  - `title`
  - `content`
  - `retrievalText`
  - `vectorSimilarity`
  - `retrievalSource` (`original-query`, `rewritten-query`, or both)
  - `dedupeKey`
- **Rules**:
  - Must remain account-scoped
  - Must survive configured minimum vector similarity filtering before reranking
  - Must deduplicate repeated hits from multiple retrieval paths

### Reranked Candidate

- **Purpose**: Retrieved candidate annotated with direct relevance for final context selection
- **Lifecycle**: Derived after semantic reranking
- **Fields**:
  - all retrieved-candidate fields
  - `relevanceScore`
  - `rerankPosition`
  - `selectedForPrompt`
- **Rules**:
  - Must preserve stable ordering for final context selection
  - Must support dropping lower-ranked candidates when prompt budget is tight

### Final Prompt Context

- **Purpose**: Ordered subset of reranked candidates passed to answer generation and citation output
- **Lifecycle**: Derived per request immediately before prompt construction
- **Fields**:
  - `chunkId`
  - `documentId`
  - `title`
  - `promptPosition`
  - `estimatedTokenCost`
- **Rules**:
  - Must fit within answer-generation context budget
  - Must preserve citation traceability back to retrieved chunks

### Retrieval Execution Record

- **Purpose**: Audit-friendly execution evidence for one retrieval run
- **Current Source**: Existing audit event metadata, expanded for richer retrieval diagnostics
- **Fields**:
  - `accountId`
  - `conversationId`
  - `rewriteStatus`
  - `rerankStatus`
  - `originalCandidateCount`
  - `rewrittenCandidateCount`
  - `normalizedCandidateCount`
  - `finalContextCount`
  - `fallbackApplied`
- **Rules**:
  - Must not store raw sensitive document content unnecessarily
  - Must be rich enough to explain candidate reduction and fallback behavior

### Evaluation Corpus

- **Purpose**: Repeatable benchmark dataset for retrieval-quality validation
- **Lifecycle**: Test and validation artifact rather than production runtime data
- **Fields**:
  - `documentSet`
  - `knownAnswerQueries`
  - `followUpQueries`
  - `expectedSupportingDocuments`
  - `expectedFallbackCases`
- **Rules**:
  - Must be stable enough for repeated benchmarking
  - Must cover direct questions, referential follow-ups, noisy corpora, and fallback scenarios
