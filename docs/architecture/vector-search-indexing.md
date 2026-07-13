---
title: "Vector Search Indexing"
description: "Design for isolating vector storage behind adapters while keeping PostgreSQL as the canonical source, with a future backend evaluation path."
last_updated: 2026-07-13
---

# Vector Search Indexing

This document describes how Radioso should isolate vector search infrastructure
while keeping PostgreSQL as the canonical application database. It separates
what exists today from future decisions that are agreed in direction but not
implemented yet.

The current implementation still uses PostgreSQL with pgvector. The immediate
goal is not to change behavior. The goal is to keep pgvector-specific work
behind focused adapters so a future vector backend can be evaluated without
rewriting document ingestion or retrieval orchestration.

## Current State

PostgreSQL stores the canonical document and chunk records. It also stores
embedding vectors today through pgvector columns on `chunks`.

The current retrieval read side has a `VectorSearchPort` implemented by
`PgVectorSearch`. The write side delegates pgvector-specific chunk insert
details through `ChunkVectorStoragePort`, implemented by
`PgVectorChunkStorage`.

Canonical chunk persistence is owned by the Documents module in
`backend/src/modules/documents/infra/chunkRepository.ts`. That repository writes
the canonical chunk row and delegates vector storage details through the
retrieval-owned adapter.

Chunk filtering for PostgreSQL retrieval is shared through `compilePgChunkFilter`
so vector and lexical search use the same source and metadata filter semantics.

## Source Of Truth

PostgreSQL remains authoritative for:

- documents
- chunks
- chunk text and search text
- chunk metadata
- workspace and source ownership
- document processing state
- embedding model settings and processing decisions
- chunk temporal metadata and stored date columns used for event-date lookup

PostgreSQL does not have to remain authoritative for embedding vector bytes if a
dedicated vector index is added later. In that model, the vector store is a
rebuildable retrieval index.

Rebuild must start from PostgreSQL canonical chunks. Depending on the selected
storage policy, rebuild may either copy stored vectors from PostgreSQL or
regenerate embeddings from chunk text using the recorded embedding model.

## Boundary Direction

The boundary should stay vector-only at first.

Lexical search and hybrid retrieval should remain PostgreSQL-resident until
there is a separate design decision to move lexical search. Moving only vector
search out means hybrid retrieval crosses a transport boundary. That may be
acceptable later, but it should be measured and designed explicitly.

The first external backend, if any, should implement the same application
semantics as pgvector:

- workspace isolation
- source scoping, including unassigned documents
- metadata filters
- embedding model isolation
- embedding dimension routing
- similarity thresholds
- deterministic document and chunk identifiers

## Adapter Roles

`ChunkVectorStoragePort` owns pgvector write details used during canonical chunk
publication. It handles current storage choices such as bounded and unbounded
vector columns and vector serialization.

`VectorSearchPort` owns vector candidate retrieval. `PgVectorSearch` remains the
default implementation.

`compilePgChunkFilter` owns PostgreSQL filter SQL for chunk retrieval. It keeps
source and metadata filter handling consistent between vector and lexical
search.

Temporal event lookup is a retrieval-owned PostgreSQL read path over canonical
chunk metadata. Ingestion enrichment may add `dateFrom` and `dateTo` to chunk
metadata, and stored date columns make upcoming-event lookup and ordering
indexable. Retrieval consumes those fields only as metadata; it does not import
ingestion enrichment contracts.

A future external vector backend should not replace these contracts by leaking
backend-specific query details into document processing or retrieval pipeline
services.

## Future Index Port

This section is decided direction, not implemented behavior.

If a dedicated vector store becomes necessary, add a higher-level vector index
port rather than wiring the new store directly into ingestion.

The port should support:

- upserting chunk vectors and searchable payloads
- deleting vectors by document, source, and workspace
- searching by workspace, embedding, `topK`, threshold, embedding model, source
  filter, and metadata filter
- reporting health and index lag
- rebuilding all, workspace-scoped, and document-scoped index data from
  PostgreSQL chunks

Embedding model and dimensions should be explicit routing inputs. Many vector
stores need a collection or index per vector shape. Treat this as routing, not
only as a metadata filter.

## Consistency Model

This section is decided direction, not implemented behavior. There is no vector
index outbox table today.

Do not dual-write synchronously to PostgreSQL and an external vector service
inside the same PostgreSQL transaction.

If an external vector index is introduced, use a durable outbox or job table:

1. Write canonical chunk state to PostgreSQL in the normal transaction.
2. Record index work durably.
3. Process index work asynchronously with idempotent retries.
4. Let reads tolerate temporary index lag.

The retrieval layer must define what happens when the vector index is stale,
partially rebuilt, or missing recently published chunks.

## Rebuild And Recovery

This section is decided direction, not implemented behavior. There is no
external-vector-index rebuild command today.

Rebuild-from-PostgreSQL is required before any external vector backend is
production-ready.

Rebuild should support:

- one document
- one workspace
- all workspaces
- dry-run or count comparison where practical

The key point is that a lost or corrupted vector index must not lose Radioso
application data. The index should be recoverable from canonical chunks and the
configured embedding model policy.

## Candidate Backends

Do not add an external backend until there is either measured pgvector scaling
pain or a specific deployment requirement.

If a backend prototype is justified, evaluate self-hostable vector stores first.
Qdrant is the likely first candidate because it has a TypeScript client, payload
filters, and a simple operational model. Weaviate and Milvus can be considered
later for deployments that need their tradeoffs.

OpenSearch should be treated as a separate search-system decision because it
would invite moving lexical and hybrid search, not only vector search.

## Test Requirements

No-behavior-change refactors should keep the current pgvector path as the
default and verify:

- chunk publication still stores searchable chunks
- vector retrieval still respects workspace, source, metadata, model, and
  dimension filters
- lexical retrieval uses the same source and metadata filter semantics
- temporal candidate retrieval respects workspace, source, and chunk date
  semantics when enriched chunks are present
- existing persistence integration tests still pass

Before enabling an external vector backend, add focused tests for:

- idempotent index upsert and delete
- delayed indexing
- failed indexing and retry
- stale index reads
- document reprocessing
- embedding model changes
- full and scoped rebuild
- result parity against the pgvector adapter on controlled fixtures
