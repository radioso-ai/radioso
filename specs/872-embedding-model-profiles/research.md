# Research: Generic Embedding Spaces and Vector Ports

## Decisions

### Preserve the product catalog; make capability metadata internal

The product surface remains the current four-model enum. A typed internal descriptor
records provider, native/expected dimensions, purpose mapping, normalization, batch
limits and vector-affecting options. Provider selection is resolved from the workspace
binding, never inferred from the model string.

OpenAI's embeddings API supports a `dimensions` parameter only for
`text-embedding-3` models and documents bounded input/batch behavior. The adapter must
send dimensions only when the catalog descriptor requires it and the model supports it.
[OpenAI embeddings API](https://platform.openai.com/docs/api-reference/embeddings/create)

Google documents `gemini-embedding-001` output dimensionality and distinct retrieval
task types. The provider adapter owns mapping common document/query purposes to those
task types and normalization behavior; the common port does not.
[Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings)

### Use immutable vector-space identity

A model name alone is insufficient because endpoint scope, dimensions, normalization,
task mapping and model-version signals can change compatibility. The fingerprint
therefore includes all vector-affecting fields but excludes credentials and raw
endpoint strings. Credential rotation within an unchanged opaque endpoint scope is not
a new space.

### Keep full precision canonical; treat indexes as projections

PostgreSQL stores rebuildable full-precision vectors independently of the selected
index route. The default pgvector adapter searches them directly; reduced-precision or
quantized indexes produce candidates only and final scoring uses canonical vectors.
This also permits a future external index to be rebuilt without provider calls.

pgvector documents HNSW support for `vector` through 2,000 dimensions and `halfvec`
through 4,000, plus binary quantization/reranking and iterative scans for filtered
approximate search. These are candidates, not automatic choices: committed benchmark
evidence must qualify each route.
[pgvector indexing and limits](https://github.com/pgvector/pgvector#hnsw)

### Use an additive shadow rollout

Startup migrations create empty metadata/canonical/outbox tables and bounded indexes
only. A resumable reconciler materializes equivalent legacy profiles, copies vectors in
batches, compares counts/dimensions/candidates/scores, and cuts over one workspace at a
time. Legacy columns remain for a later removal feature.

### Keep queue payloads identifier-only

The existing durable PostgreSQL job row remains authoritative and gains target
profile, revision and workspace-generation fields. AMQP and Cloud Tasks continue
transporting the job ID only, avoiding a public/cross-service payload change while
still making retries deterministic.

### Make projection consistency application-owned

Canonical writes and monotonic projection work commit atomically. The application owns
dispatch, lag, checkpoints and scoped rebuild. An adapter owns capability discovery,
prepare/reset, versioned mutations, candidate search and backend readiness only. The
default pgvector adapter can acknowledge same-transaction work; a test-only
external-style adapter proves asynchronous semantics.

### Benchmark rather than assume safe routes

`embedding-index-v1` fixes dimensions, corpus size, selectivity, candidate depth,
hardware manifest, warm-up, measured runs and deterministic exact-search recall.
`vector-projection-v1` fixes database/backend fixtures, concurrency, event rate,
warm-up and duration. Results establish the exact-search cutoff and enabled index
routes; unsupported shapes block activation above the cutoff.

### Pin the runtime

Use one supported pgvector version across local development, CI, schema generation and
deployment documentation. The official image publishes versioned PostgreSQL-specific
tags suitable for a reproducible pin.
[pgvector Docker tags](https://hub.docker.com/r/pgvector/pgvector/tags)

## Rejected Alternatives

- One vector column per dimension: schema/index proliferation and common-code branches.
- Model name plus observed dimension as identity: misses endpoint/task/normalization
  incompatibility.
- Replace vectors in place: creates partial coverage during transition.
- Provider calls during rebuild: expensive, nondeterministic, and unnecessary.
- Optional methods on the current broad vector port: hides unsupported capabilities.
- Public profile/dimension/backend APIs: explicitly outside the approved product scope.
- A Pinecone adapter in this feature: violates the PostgreSQL/pgvector principle and
  is unnecessary to prove the port.

