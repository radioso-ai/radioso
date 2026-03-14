# Research: Selectable Chunking Strategies

## Decision 1: Reuse the existing account-scoped retrieval settings seam

**Decision**: Store the selected chunking strategy in the existing retrieval settings model and reuse the current settings route, service, repository, and frontend settings screen.

**Rationale**: Chunking strategy is an account-scoped retrieval behavior choice with the same lifecycle as query rewrite, reranking, and other retrieval controls. Reusing the existing seam avoids parallel settings storage and keeps auditing, validation, and UI persistence consistent.

**Alternatives considered**:

- Create a separate chunking-settings table and endpoint: rejected because it introduces duplicate transport and persistence seams for a single additional retrieval preference.
- Keep the strategy only in frontend state: rejected because ingestion runs in the backend and the selection must persist across sessions and apply consistently to future document ingests.

## Decision 2: Introduce a dedicated chunking strategy interface and registry

**Decision**: Replace the current direct call to one chunking function with a shared chunking strategy interface and a registry or resolver selected from retrieval settings.

**Rationale**: The current ingestion flow imports one concrete chunking function directly. A dedicated interface and resolver keep `DocumentIngestionService` orchestration-only and make fixed-window and structure-aware chunking swappable without adding branching logic across routes or persistence layers.

**Alternatives considered**:

- Add a boolean flag inside the current chunking function: rejected because it concentrates two distinct behaviors in one monolithic module and weakens testability and ownership boundaries.
- Put strategy selection directly in `DocumentIngestionService` with `if` branches over multiple helpers: rejected because orchestration code would start owning chunking rules and implementation-specific fallbacks.

## Decision 3: Model the structured strategy as deterministic block parsing plus semantic merging

**Decision**: Implement the new strategy in two stages: first derive ordered structural block units using deterministic document structure rules, then merge adjacent blocks semantically while topic continuity remains high and size bounds allow it.

**Rationale**: This matches the approved product direction: use headings, paragraphs, bullets, numbered steps, tables, code fences, and FAQ pairs as deterministic structure cues, then apply adjacent semantic similarity only to decide which neighboring blocks should stay together.

**Alternatives considered**:

- Replace fixed-window chunking entirely: rejected because the approved spec requires fixed-window to remain available.
- Use language-specific regex heuristics to infer structure and topics: rejected because the approved spec explicitly forbids English-specific regex logic.
- Use embeddings alone without a deterministic block stage: rejected because it would weaken explainability and make structure preservation less predictable.

## Decision 4: Fallback within the structured strategy instead of switching strategies

**Decision**: If adjacent semantic-similarity comparison is unavailable during structured chunking, fall back within the same structured strategy to deterministic structure-only chunk assembly with the same size-bound guarantees.

**Rationale**: This preserves the operator’s selected strategy, avoids surprise fallback to fixed-window chunking, and prevents ingestion failure when similarity comparison is temporarily unavailable.

**Alternatives considered**:

- Fail the ingest when semantic similarity is unavailable: rejected because the spec requires predictable ingestion and bounded chunks even under degraded conditions.
- Silently switch to fixed-window chunking: rejected because it changes the chosen strategy without operator intent and makes behavior harder to reason about.

## Decision 5: Keep structured-chunking controls internal in this feature

**Decision**: Expose only the strategy selector in Settings. Similarity thresholds, merge heuristics, and size bounds remain implementation defaults in this feature.

**Rationale**: The first delivery goal is safe strategy selection and a stable domain seam, not a new advanced-tuning surface. Limiting the UI to one selector reduces contract churn and rollout complexity while preserving room for future configuration if needed.

**Alternatives considered**:

- Add advanced structured-chunking controls now: rejected because it expands scope into tuning UX and operator education before the core strategy seam exists.
- Reserve partial UI placeholders for future controls: rejected because it adds noise to the current settings flow without user value in this feature.

## Decision 6: Preserve the existing document ingest API contract

**Decision**: Keep document create and update endpoints unchanged. The selected chunking strategy affects backend ingest behavior only through account retrieval settings.

**Rationale**: The actor changes configuration in Settings, not per document request. Keeping ingest endpoints stable avoids spreading chunking concerns into transport contracts and preserves existing client behavior.

**Alternatives considered**:

- Add a per-request chunking strategy override to document endpoints: rejected because it conflicts with the approved account-scoped settings model and complicates ingest consistency.
- Add chunking metadata fields to document payloads immediately: rejected because the current feature only requires selection and application of strategies, not a new document contract.

## Decision 7: Cover the feature with backend-first TDD and targeted UI verification

**Decision**: Start with backend failing tests for settings validation, strategy resolution, structured chunk behavior, structured fallback behavior, and ingest application. Then add contract and integration coverage, followed by targeted frontend verification for the selector and explanatory copy.

**Rationale**: Most feature risk is in backend behavior and persistence. Once the settings and chunking seam are correct, the frontend work is a comparatively small selector update on top of a stable contract.

**Alternatives considered**:

- Build the selector UI first: rejected because the frontend would still be blocked on missing contract fields and backend behavior.
- Rely on manual verification for chunk outputs: rejected because structured chunking and fallback rules need repeatable regression coverage.
