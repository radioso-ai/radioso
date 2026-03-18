# Research: Document Metadata

## R1: Storage approach for flexible metadata

**Decision**: JSONB column on `documents` and `chunks` tables, defaulting to `'{}'`.

**Rationale**: PostgreSQL JSONB supports GIN indexing for efficient containment queries (`@>`), requires no schema changes when new keys are added, and is natively supported by the existing pg driver. The codebase already uses JSONB for `structured_attributes` on chunks, so the pattern is proven.

**Alternatives considered**:
- **Separate key-value table** (`document_metadata(document_id, key, value)`): More normalized but adds JOIN cost on every read, complicates chunk propagation, and requires multi-row inserts. Rejected for unnecessary complexity.
- **Fixed columns** (`source_url TEXT`, `language TEXT`): Simple queries but requires a migration for every new field. Rejected for inflexibility.

## R2: Metadata propagation to chunks

**Decision**: Copy document `metadata` to each chunk's `metadata` column at ingestion time, in `DocumentProcessingService.process()` — the same place where `structuredAttributes`, `searchText`, and embeddings are computed.

**Rationale**: Chunks are the retrieval unit. Storing metadata on chunks avoids a JOIN back to documents during search. The existing enrichment pipeline already transforms `ChunkOutput` → `ChunkRecord` with added fields; metadata is one more field in that mapping.

**Alternatives considered**:
- **JOIN at query time**: Avoids data duplication but adds cost to every vector/lexical search query. Both search queries already JOIN documents for `title` and `status`, so adding one more field is feasible — but having it on chunks keeps the option open for chunk-level metadata in the future. Rejected for forward flexibility.

## R3: Metadata in retrieval context

**Decision**: Add `metadata` to `RetrievedChunk` interface. Vector and lexical search queries SELECT `c.metadata`. PromptBuilder renders metadata as a "Source: {url}" line when `sourceUrl` is present.

**Rationale**: The existing pattern renders `structuredAttributes` as an "Attributes:" line in the prompt. Metadata follows the same pattern. The LLM can then naturally cite sources.

## R4: Metadata filtering

**Decision**: Add optional `metadataFilter` parameter to vector and lexical search. Apply as `AND c.metadata @> $N::jsonb` WHERE clause. The `@>` containment operator is indexed by GIN.

**Rationale**: PostgreSQL's `@>` operator with GIN index is the standard approach for JSONB filtering. It supports nested key-value matching and is efficient at scale.

**Alternatives considered**:
- **Application-level filtering** (post-query): Simpler but wasteful — fetches chunks that will be discarded. Rejected for performance.
- **Full-text search on metadata values**: Over-engineered for key-value matching. Rejected.

## R5: Size limit enforcement

**Decision**: Validate metadata size in the Zod schema at the route level. Reject payloads where `JSON.stringify(metadata).length > 16384` (16 KB). No database-level constraint needed since validation happens before persistence.

**Rationale**: Route-level validation is consistent with how `title` and `content` are validated today. 16 KB is generous for key-value metadata while preventing abuse.

## R6: Chat API integration for metadata filtering

**Decision**: Add optional `metadataFilter` field to the chat message request body. Pass it through `ChatService` → `RetrievalPipelineService` → vector/lexical search. This keeps filtering logic in the retrieval layer, not in chat routes.

**Rationale**: The spec's Architecture Constraints require that metadata filtering belongs in the retrieval pipeline, not the chat handler. The chat service just passes it through.
