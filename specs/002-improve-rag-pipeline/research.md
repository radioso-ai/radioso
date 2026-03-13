# Research: Universal Retrieval Quality Upgrade

## Decision 1: Use model-backed query rewriting with bounded conversation context

- **Decision**: Replace the current history-concatenation rewrite behavior with a model-backed rewrite step that receives a bounded, retrieval-focused conversation context and returns a retrieval-only standalone query.
- **Rationale**: The current rewrite service only concatenates recent user turns, which is too weak for referential follow-ups and too noisy for strict retrieval profiles. A model-backed rewrite can preserve intent, resolve references, and keep proper nouns intact while still falling back safely to the original query when rewrite output is low confidence or unusable.
- **Alternatives considered**:
  - Keep simple string concatenation: too brittle for real follow-up retrieval
  - Send full conversation every time: higher cost, less predictable output, worse prompt hygiene
  - Persist conversation summaries as part of this feature: useful later, but broader than needed for the current upgrade

## Decision 2: Retrieve candidates from both the original and rewritten query paths

- **Decision**: Build the first-pass candidate set from both the original query and the rewritten retrieval query, then merge and deduplicate before reranking.
- **Rationale**: Some direct questions retrieve better with the user's original wording, while referential follow-ups often retrieve better with the rewritten standalone query. A combined candidate path improves recall without changing the public API and reduces the risk that a bad rewrite starves retrieval.
- **Alternatives considered**:
  - Use only the rewritten query when rewrite is enabled: simpler, but too fragile when rewrite underperforms
  - Use only the original query: loses the benefit of conversation-aware rewrite
  - Average or blend embeddings before search: harder to reason about and debug than explicit multi-query retrieval

## Decision 3: Keep vector-similarity thresholding before reranking, but normalize candidates first

- **Decision**: Apply the configured minimum vector similarity policy to first-pass vector candidates before reranking, then normalize, deduplicate, and annotate the surviving candidate set before semantic reranking.
- **Rationale**: This matches the approved specification semantics and keeps the threshold meaningful as a first-pass relevance gate. Candidate normalization before reranking ensures that duplicate chunks or repeated hits from original and rewritten query paths do not waste rerank capacity.
- **Alternatives considered**:
  - Threshold after reranking: conflicts with the approved retrieval-pipeline semantics
  - No threshold until final answer selection: allows too many weak candidates into downstream stages
  - Hard fail when rewrite-path thresholding yields nothing: weaker fallback behavior than required

## Decision 4: Replace keyword-based reranking with model-assisted semantic reranking

- **Decision**: Use a model-assisted rerank step that scores the normalized candidate set for direct relevance to the retrieval query and returns an ordered subset for final prompt selection.
- **Rationale**: Keyword overlap is insufficient for distinguishing answer-bearing chunks from loosely related chunks, especially with large candidate sets. A model-backed rerank step aligns with the approved spec, improves precision, and remains compatible with the existing LLM provider constraint.
- **Alternatives considered**:
  - Keep keyword-overlap rerank: too weak to support universal retrieval improvements
  - Introduce a separate dedicated rerank provider: possible later, but widens configuration scope unnecessarily for this feature
  - Skip reranking and rely only on vector ordering: not enough control over citation quality in noisy corpora

## Decision 5: Introduce explicit prompt-context budgeting after reranking

- **Decision**: Add a dedicated context-selection step that trims the reranked candidate set to fit answer-generation budget while preserving the highest-ranked, most useful chunks.
- **Rationale**: Final context depth and LLM prompt budget are separate concerns. Explicit context budgeting prevents large rerank windows from overflowing answer prompts and makes the final prompt set deterministic and testable.
- **Alternatives considered**:
  - Send the full reranked set to answer generation: unpredictable prompt size and latency
  - Apply budget before reranking: throws away potentially useful candidates too early
  - Hide context trimming inside prompt construction: obscures ownership and makes tests weaker

## Decision 6: Improve retrieval text quality at ingestion time

- **Decision**: Enrich retrieval text at ingestion by combining chunk content with stable document context such as title-derived cues before embedding and storage.
- **Rationale**: Better rewrite and rerank alone cannot recover recall if the stored retrieval representation is too thin. Title-aware or metadata-aware retrieval text improves first-pass retrieval quality while staying within the existing document-ingestion pipeline.
- **Alternatives considered**:
  - Leave ingestion embeddings unchanged: lower implementation scope, but weaker recall improvements
  - Store only raw chunk content: simpler, but loses stable document-level signals
  - Add a separate metadata index outside pgvector: unnecessary scope expansion for this feature

## Decision 7: Record retrieval execution diagnostics in audit-friendly metadata

- **Decision**: Extend per-request retrieval execution evidence to capture rewrite status, rerank status, candidate counts, and final-context selection details without exposing sensitive raw document content.
- **Rationale**: Universal retrieval tuning requires operators to understand whether poor outcomes came from rewrite, thresholding, candidate preparation, or rerank stages. Existing audit coverage is too coarse for retrieval debugging.
- **Alternatives considered**:
  - Keep only success/failure audit events: insufficient for diagnosis
  - Log full retrieved content: too risky for customer data handling
  - Build a separate observability subsystem now: broader than needed for the current feature

## Decision 8: Validate retrieval quality with a repeatable benchmark corpus

- **Decision**: Add a repeatable evaluation workflow built from representative ingested documents, known-answer direct questions, and referential follow-up questions.
- **Rationale**: Success criteria around grounding, follow-up resolution, and noisy-corpus citation quality are only meaningful if measured against a stable benchmark. A repeatable corpus also reduces regression risk as rewrite and rerank behavior evolve.
- **Alternatives considered**:
  - Ad hoc manual spot checks only: too weak for ongoing retrieval tuning
  - Large external benchmark integration now: more scope than needed for the current repository
  - Purely synthetic question generation without human verification: too risky for acceptance decisions
