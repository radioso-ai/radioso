# Feature Specification: Generic Embedding Spaces And Vector Ports

**Feature Branch**: `support-variable-embedding-dims`  
**Created**: 2026-07-26  
**Status**: Approved for implementation  
**Input**: User description: "Support the four embedding models currently present at their appropriate vector dimensions, and make vector persistence, transition, and retrieval generic so other models or a future backend such as Pinecone do not require model- or dimension-specific changes to the common ports. Do not expand model-selection UI or API flexibility."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Use Current Models At Their Supported Dimensions (Priority: P1)

A workspace operator can continue selecting one of the four currently supported
embedding models through the existing settings experience, while the platform
validates and stores the model's declared or returned vector shape without forcing
every model into 1536 dimensions.

**Why this priority**: The existing selector already exposes the intended product
choice; the missing capability is safe, dimension-independent behavior behind it.

**Independent Test**: Select each currently supported model with its configured
provider, ingest representative documents, verify the stored embedding-space
identity and dimensions, and retrieve those documents semantically without
changing a vector port for any model.

**Acceptance Scenarios**:

1. **Given** the existing settings API and UI, **When** an operator chooses an embedding model, **Then** exactly the current four supported choices remain available.
2. **Given** a selected current model produces a vector dimension other than 1536, **When** the workspace ingests and searches documents, **Then** the model's compatible dimension is preserved end to end.
3. **Given** automatic validation returns malformed, empty, inconsistent, or non-finite vectors, **When** a model transition is attempted, **Then** activation is rejected and the workspace's active embedding configuration remains unchanged.
4. **Given** any current supported model, **When** it is processed through generation, persistence, indexing, and retrieval, **Then** none of the common vector ports branch on that model identifier.

---

### User Story 2 - Change Embedding Space Without Search Downtime (Priority: P1)

A workspace operator can change the embedding model or dimensions for an existing
workspace while semantic retrieval continues using the complete active vector
space until a replacement is fully built and verified.

**Why this priority**: Replacing vectors document by document creates partial
semantic coverage and makes model changes operationally unsafe.

**Independent Test**: Start with a searchable workspace, request a different
embedding model, interrupt and resume reprocessing, verify active semantic results
throughout, complete the transition, atomically activate the replacement, and
verify prior-profile data is removed only after the bounded cleanup grace period
and all references to it have drained.

**Acceptance Scenarios**:

1. **Given** an existing searchable workspace, **When** a model change begins, **Then** active embeddings remain available while replacement embeddings are built alongside them.
2. **Given** only part of the workspace has replacement embeddings, **When** users search, **Then** semantic retrieval continues exclusively against the complete active embedding space.
3. **Given** all eligible documents have valid replacement embeddings and the replacement index is ready, **When** promotion completes, **Then** retrieval switches atomically to the replacement embedding space.
4. **Given** processing or indexing is interrupted, **When** work resumes or retries, **Then** completed work is reused safely and duplicate vectors do not appear.
5. **Given** a replacement fails validation or indexing, **When** the failure is reported, **Then** the active embedding space remains unchanged and the operator receives actionable status.
6. **Given** an embedding-only transition is running, **When** users retrieve or operators inspect documents, **Then** canonical chunks, document revisions, and ready status are not replaced or reset merely to build the pending profile.

---

### User Story 3 - Retrieve Predictably Across Supported Vector Dimensions (Priority: P2)

Workspace users receive grounded retrieval from the active embedding space
regardless of its vector dimensions, with index readiness and degraded fallback
made explicit to operators.

**Why this priority**: Generic vector storage is insufficient if non-default
dimensions silently receive unacceptable search latency or incompatible
comparisons.

**Independent Test**: Exercise representative low-, current-, and
higher-dimensional profiles, confirm dimension-safe candidate retrieval, compare
indexed latency and result quality against exact search, and verify explicit
degraded status when indexed acceleration is unavailable.

**Acceptance Scenarios**:

1. **Given** stored vectors from several embedding spaces, **When** a semantic query runs, **Then** only vectors belonging to the active compatible embedding space are compared.
2. **Given** the active vector shape has a ready accelerated index, **When** users search, **Then** retrieval uses that index and returns hydrated canonical chunks.
3. **Given** an active vector shape does not yet have accelerated indexing, **When** the workspace is within the documented exact-search safety threshold, **Then** retrieval remains correct and operators can see that it is running in degraded exact-search mode.
4. **Given** a workspace exceeds the exact-search safety threshold and no suitable index is ready, **When** activation is attempted, **Then** activation is blocked rather than silently accepting unbounded latency.
5. **Given** an approximate candidate index is used, **When** quality is evaluated against exact search, **Then** final candidate quality meets the documented acceptance threshold.

---

### User Story 4 - Add A Future Vector Backend Through A Stable Contract (Priority: P2)

A platform engineer can implement a future external vector backend, such as
Pinecone, without changing document processing orchestration, embedding-profile
lifecycle, retrieval ranking, canonical chunk hydration, or public workspace
settings contracts.

**Why this priority**: The current PostgreSQL-coupled write seam would otherwise
force a cross-module rewrite when a deployment needs another vector system.

**Independent Test**: Run the backend-neutral vector adapter conformance suite
against an in-memory external-style adapter and verify capability discovery,
space preparation/reset, versioned writes/deletes, portable candidate search,
and health/readiness without PostgreSQL; separately verify application-owned lag,
retry, ordering, and scoped rebuild behavior.

**Acceptance Scenarios**:

1. **Given** an adapter implements the common vector write, search, and administration contracts, **When** it is selected in application composition, **Then** document publication and retrieval operate without domain-module changes.
2. **Given** an external-style adapter is temporarily unavailable, **When** vector publication retries, **Then** canonical document data remains durable and index work can resume without duplicate records.
3. **Given** an external index is lost or rebuilt, **When** a scoped rebuild is requested, **Then** the application can stream canonical chunk embeddings and immutable embedding-space information through the common writer without the adapter reading PostgreSQL.
4. **Given** a document, source, or workspace is deleted, **When** index synchronization completes, **Then** corresponding external-style vectors are removed idempotently.

### Edge Cases

- A provider returns a different dimension during a later call for an existing profile.
- A batch contains fewer vectors than inputs, mixed dimensions, zero vectors for cosine search, or non-finite values.
- The same model identifier is served by two provider connections or endpoint configurations.
- A model supports optional reduced dimensions and an operator changes only that option.
- A document is added, updated, disabled, expires, or is deleted while a workspace transition is running.
- An operator cancels a transition after some replacement vectors have been written.
- Two operators attempt different embedding changes concurrently.
- The API, document worker, or vector-index worker restarts during publication or promotion.
- The vector index is healthy but behind canonical PostgreSQL state.
- A profile's accelerated index is unavailable, building, stale, or exceeds its supported vector shape.
- A legacy workspace has 1536-dimensional chunks but no explicit embedding profile.
- Cleanup begins while a late retry or rebuild still references the prior profile.
- A deletion arrives before an earlier upsert for the same chunk.
- An external-style backend returns duplicate, missing, cross-workspace, or stale candidate identifiers.
- A job pinned before profile activation completes after the workspace generation has changed.
- A disabled or expired document is re-enabled after it was excluded from transition coverage.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is explicitly approved.
- Backend changes MUST follow TDD: failing tests before production implementation.
- Backend remains Node.js, frontend remains React, and PostgreSQL remains the
  system of record for workspace, document, chunk, profile, transition, and
  durable index-work state.
- `pgvector` remains the default vector adapter; this feature MUST NOT implement
  Pinecone or another external vector service.
- Secrets and provider credentials MUST remain in existing encrypted workspace
  credential storage or environment configuration and MUST NOT be included in
  embedding-profile fingerprints, logs, audit payloads, or API responses.
- Public API changes MUST be code-first, regenerate checked-in OpenAPI artifacts,
  update the TypeScript SDK, and include contract tests.
- Worker and vector-index work contract changes MUST include AMQP/Cloud Tasks
  payload, idempotency, retry, ordering, and documentation review.
- Operator-facing settings and lifecycle changes MUST update the canonical
  settings documentation and its frontend copy.
- Frontend user journeys MUST prefer Playwright coverage; frontend unit tests
  remain limited to state and API logic.
- Observability MUST exclude prompts, document content, chunk text, vectors,
  credentials, cookies, and connection strings.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Settings owns embedding-profile selection and transition
  lifecycle; LLM provider infrastructure owns model discovery, probing, and
  embedding calls; Documents owns canonical chunks and durable processing jobs;
  Retrieval owns backend-neutral vector indexing and candidate search;
  persistence adapters own PostgreSQL details; application composition selects
  concrete provider and vector adapters.
- **Independence Rule**: The embedding-generation provider and the vector-index
  backend are separate choices. Provider identity and options define vector-space
  compatibility; vector-backend selection defines only where compatible vectors
  are projected and searched.
- **Generation Ownership Rule**: Embedding Profiles owns model descriptors,
  provider binding, purpose mapping, dimensions, validation, probing, and the
  shared generation service. Retrieval, Documents, and semantic chunking consume
  separate purpose-specific ports. Retrieval may request a query embedding and
  receive an opaque embedding-space reference plus vector, but MUST NOT accept or
  expose model, provider, dimension, normalization, or provider-task inputs.
- **Vector Backend Rule**: Domain and orchestration modules MUST depend on narrow,
  mandatory backend-neutral vector writer, search, and administration ports.
  Port inputs and outputs MUST use logical identifiers, embedding-space identity,
  versioned vectors, portable filters, normalized scores, capabilities, space
  preparation/reset, and backend health/readiness only. Application reconciliation
  owns lag and rebuild coordination. Ports MUST NOT expose database clients, SQL
  fragments, provider SDK payloads, table names, collection names, or
  backend-specific consistency controls.
- **Source-Of-Truth Rule**: PostgreSQL canonical chunks, immutable embedding
  profiles, full-precision canonical chunk embeddings, and durable index work MUST
  be sufficient to rebuild any configured vector index without another provider
  call. Search adapters return ranked identifiers; canonical chunk hydration and
  final authorization/filter enforcement remain application-owned.
- **Rebuild Ownership Rule**: Application reconciliation owns durable outbox
  high-water marks, lag, and rebuild orchestration. A vector adapter owns only its
  capabilities, backend health/readiness, prepared vector spaces, versioned
  mutations, and candidate search; it MUST NOT read PostgreSQL or orchestrate
  canonical rebuilds.
- **Consistency Rule**: Canonical publication and durable vector-index work are
  committed before backend synchronization. External-style synchronization MUST
  be asynchronous, idempotent, retryable, observable, and tolerant of temporary
  lag. Request handlers MUST NOT synchronously dual-write PostgreSQL and a vector
  backend.
- **Serialization Rule**: Canonical chunk publication, deletion, transition
  cancellation, cleanup, and activation MUST share a workspace/profile generation
  fence. Activation MUST recheck canonical coverage and backend readiness under
  that fence and compare-and-swap the expected active generation.
- **Encapsulation Rule**: `documentProcessingService.ts`,
  `ingestionSettingsService.ts`, HTTP routes, and frontend settings components
  remain orchestration or presentation surfaces; they MUST NOT absorb provider
  capability rules, index DDL, backend routing, vector serialization, transition
  reconciliation queries, or cleanup policy.
- **New Seams Required**: Immutable embedding-space domain; internal workspace
  profile lifecycle; internal supported-model descriptor/probe port; vector
  validation service; vector capability/writer/search/admin
  ports; durable index-work/outbox repository; transition coordinator; index
  reconciliation and rebuild service; backend-neutral adapter conformance suite.
- **Composition Rule**: Default pgvector implementations and future vector backend
  selection belong in `backend/src/app/composition/`; product rules MUST remain in
  their owning modules.
- **Anti-Goals**: Do not add one vector column per dimension. Do not use model
  name alone as vector-space identity. Do not perform runtime index DDL in an HTTP
  request. Do not mix active and pending vector spaces in one semantic query. Do
  not make Documents import pgvector or a future vendor SDK. Do not make
  Retrieval hydrate or authorize vendor payloads directly. Do not add optional
  methods to a broad port as a substitute for explicit capabilities. Do not make
  Retrieval the public surface for general embedding generation or reuse its
  query-embedding port for document or clustering purposes.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The settings API and UI MUST continue exposing exactly the four
  currently supported embedding model identifiers and MUST NOT add free-form model
  identifiers, requested dimensions, profile creation, or vector-backend controls.
- **FR-002**: Internally, each of the four supported models MUST resolve through a
  typed model descriptor and the common vector ports MUST NOT contain
  model-identifier branches or model-specific dimensions.
- **FR-003**: The system MUST automatically validate a supported model's output
  contract before starting a new model transition; this validation MUST NOT
  require a new public probe or profile API. Legacy-equivalent profiles MAY be
  materialized from already stored vectors under FR-009.
- **FR-004**: Every embedding space MUST immutably identify its provider
  implementation, opaque non-secret endpoint-scope fingerprint, model identifier,
  dimensions, distance semantics, normalization behavior, document/query task
  mapping, and other vector-affecting provider options.
- **FR-005**: Embedding-space identity MUST exclude credentials, secrets, and raw
  endpoint strings while still distinguishing endpoint scopes that may produce
  incompatible vectors.
- **FR-006**: Provider responses MUST be rejected unless vector count, numeric
  finiteness, non-zero requirements, and dimensions match the requested profile.
- **FR-007**: A dimension change, endpoint-scope change, model-version signal, or
  other vector-affecting descriptor change MUST create a new embedding space rather
  than mutate an existing space. Credential rotation against the same immutable
  endpoint scope MUST NOT require re-embedding.
- **FR-008**: Each workspace MUST resolve its existing selected model to one active
  internal embedding profile and at most one pending transition target.
- **FR-009**: Existing 1536-dimensional workspaces MUST migrate to an equivalent
  explicit profile without requiring immediate re-embedding.
- **FR-010**: Replacement embeddings MUST coexist with active embeddings until the
  replacement is complete and ready.
- **FR-011**: User retrieval MUST continue against the complete active profile
  throughout replacement processing.
- **FR-012**: Promotion MUST be atomic and MUST require all eligible current
  document revisions to have valid replacement vectors plus a ready vector index.
- **FR-013**: Document mutations during a transition MUST be reconciled into both
  the active and pending profiles and fenced against activation; activation MUST
  recheck coverage and the vector-backend checkpoint while holding the same
  workspace/profile generation fence used by canonical publication and deletion.
- **FR-014**: The existing settings surface MUST continue showing active and pending
  model state and MUST report a safe transition failure without exposing internal
  profile identifiers, document content, vectors, or vector-backend controls.
- **FR-015**: Authorized operators MUST be able to cancel an unpromoted transition
  without changing the active profile.
- **FR-016**: After promotion, prior-profile embeddings MUST be retained only for a
  bounded cleanup grace period and removed asynchronously once no active, pending,
  rebuild, or in-flight work references them. This feature MUST NOT add a public
  rollback control.
- **FR-017**: The system MUST prevent concurrent conflicting transitions for one
  workspace.
- **FR-018**: Vector search MUST route by the active profile's immutable embedding
  space, not by model name and observed dimensions alone.
- **FR-019**: Vector search MUST never compare vectors from incompatible profiles
  or dimensions.
- **FR-020**: The default vector adapter MUST provide accelerated search for
  documented supported vector shapes and correct exact-search fallback for safe
  corpus sizes.
- **FR-021**: The system MUST expose whether a profile is using an accelerated,
  building, stale, unavailable, or exact-fallback index.
- **FR-022**: Activation MUST be blocked when the workspace exceeds the documented
  exact-search safety threshold and no suitable accelerated index is ready.
- **FR-023**: Approximate search strategies MUST retrieve sufficient candidates for
  final scoring quality to meet the documented recall threshold against exact
  search.
- **FR-024**: Canonical chunk publication MUST create all required
  embedding-generation work for active and pending profiles in the same PostgreSQL
  transaction or equivalent atomic unit.
- **FR-025**: Every vector mutation MUST carry a monotonic canonical/index version.
  Upserts, supersessions, and durable tombstones MUST be idempotent and safe under
  duplicate and out-of-order delivery so a late upsert cannot resurrect a deleted
  or superseded chunk revision.
- **FR-026**: Application reconciliation MUST report lag between durable canonical
  work and the adapter's acknowledged high-water mark and MUST NOT present stale or
  incomplete replacement data as ready for promotion.
- **FR-027**: An application-owned rebuild coordinator MUST stream canonical
  embeddings through backend-neutral prepare/reset and writer ports for document,
  workspace, embedding-space, and full-deployment scopes.
- **FR-028**: Loss of a rebuildable vector index MUST NOT lose canonical document,
  chunk, or embedding-profile state.
- **FR-029**: The common vector contracts MUST support capability discovery,
  vector-space preparation/reset, versioned upsert/delete, candidate search, and
  backend health/readiness required by both the default adapter and a future
  external adapter. Application reconciliation MUST own lag and scoped rebuild.
- **FR-030**: A backend-neutral conformance harness MUST verify common vector
  adapter behavior without embedding PostgreSQL or vendor assumptions.
- **FR-031**: The current default vector implementation MUST be assembled through
  application composition; adding a conforming future adapter MUST NOT require
  changes to document processing, retrieval orchestration, profile lifecycle, or
  public workspace APIs.
- **FR-032**: Internal profile initialization, transition start, cancellation,
  promotion, cleanup, rebuild, and terminal failure MUST emit appropriate audit or
  operator events through existing observability surfaces.
- **FR-033**: Runtime observability MUST expose dimension bucket, backend,
  readiness, lag, duration, retry, fallback, and outcome signals, with
  access-controlled correlation identifiers in logs/traces where needed and no
  vector or customer-content payloads.
- **FR-034**: Public settings request and response shapes for embedding selection
  MUST remain backward compatible and continue using the current four-model enum;
  internal embedding-space and vector-backend identities MUST NOT become new
  user-selectable API resources.
- **FR-035**: Existing TypeScript SDK settings operations and types MUST remain
  compatible; this feature MUST NOT add custom model, requested-dimension, internal
  profile, or vector-backend selection operations.
- **FR-036**: Operator and architecture documentation MUST describe model
  validation, dimensions, transition behavior, index readiness, degraded modes,
  cleanup, and the vector adapter boundary.
- **FR-037**: The repository MUST use a pinned, supported vector extension/runtime
  version consistently in local development, CI, schema generation, and deployment
  documentation.
- **FR-038**: Embedding-only backfill MUST NOT increment document revisions,
  change ready documents to queued or processing, delete canonical chunks, or
  trigger unrelated enrichment work.
- **FR-039**: Durable embedding work MUST pin its immutable target profile and
  current document/chunk revision in PostgreSQL; queue transport messages MAY
  continue carrying only the authoritative job identifier.
- **FR-040**: Full-precision canonical chunk embeddings MUST remain in PostgreSQL
  independently of the selected vector-index backend so a lost external-style
  index can be rebuilt without repeating provider calls.
- **FR-041**: A vector-index backend outage MUST preserve lexical retrieval and
  report semantic retrieval as degraded or unavailable; the system MUST NOT query
  a different embedding profile as an implicit fallback.
- **FR-042**: A profile that exhibits objectively detectable output-contract drift
  after validation—count,
  dimensions, numeric validity, non-zero requirements, normalization tolerance,
  or provider model-version signal—MUST be quarantined from new activation and
  MUST block an in-progress transition without changing the active profile.
- **FR-043**: Schema rollout MUST be additive and bounded at startup; bulk vector
  copying, provider backfill, and accelerated-index construction MUST run as
  resumable background work rather than startup migration statements.
- **FR-044**: Compatibility rollout MUST support shadow validation and
  workspace-scoped cutover from legacy vector columns before those columns and
  indexes are removed in a later release.
- **FR-045**: Transition promotion MUST occur automatically and idempotently after
  an operator-requested target passes coverage and readiness gates; reading
  settings MUST NOT itself cause promotion.
- **FR-046**: Transition eligibility at activation MUST include every current
  canonical chunk belonging to a ready, retrieval-enabled, non-expired document.
  Queued, processing, failed, disabled, and expired documents MAY be excluded, but
  they MUST NOT later become retrievable until active-profile canonical embeddings
  and backend readiness exist for their current chunks.
- **FR-047**: A document or embedding job pinned to an older workspace/profile
  generation MUST compare-and-swap against the current generation before
  publication and either enqueue/complete current-profile work or become
  superseded; it MUST NOT publish an incompatible ready state after cutover.
- **FR-048**: Cancelled, superseded, or cleanup-tombstoned transition work MUST
  become a no-op at commit time even if it was previously claimed. Cleanup MUST
  refuse to remove a profile referenced by active, pending, in-flight, or rebuild
  state.
- **FR-049**: The default pgvector adapter MUST search canonical PostgreSQL chunk
  embeddings directly. Its per-vector synchronization is complete with the
  canonical transaction; its readiness reflects canonical coverage and accelerated
  index-route state. The durable outbox MUST remain available for future
  asynchronous external projections.
- **FR-050**: The shared adapter conformance harness MUST contain no PostgreSQL or
  vendor assumptions. The in-memory external-style adapter MUST run it without
  PostgreSQL, while the default adapter MUST run the same behavioral cases as
  PostgreSQL integration tests.
- **FR-051**: Before implementation begins, the technical plan MUST commit a
  reproducible benchmark matrix covering corpus sizes, vector dimensions,
  candidate depths, filter selectivity, runtime resources, warm-up, run count,
  exact-search cutoff, index strategy, deterministic recall calculation, and a
  `vector-projection-v1` outbox/worker load profile with fixed database/backend
  fixture, worker concurrency, event rate, warm-up, and run duration.
- **FR-052**: Existing provider credentials and configured endpoint scope MUST
  resolve internally without entering embedding-space fingerprints. Deleting or
  disabling required credentials MUST NOT delete profiles or vectors; active
  semantic generation MUST degrade safely and pending transitions MUST block.
- **FR-053**: Existing workspace settings-read and LLM-model management permissions
  MUST continue governing model reads and changes. Cleanup MUST be system-owned,
  and scoped/full rebuild operations MUST require existing privileged operator or
  administrative authority.
- **FR-054**: Automatic model validation MUST use a fixed, non-customer test string
  and MUST NOT reveal endpoint configuration, credentials, raw provider payloads,
  internal profile IDs, or secret hashes in API responses, audit events, logs, or
  traces.
- **FR-055**: Model selection MUST remain constrained to the current four-model
  enum. Internally observed dimensions MUST be positive and no greater than 16,000
  and MUST be supported by both the model descriptor and vector-backend capability
  descriptor.
- **FR-056**: Probe and embedding requests MUST enforce explicit time, batch,
  input, vector-count, and response-size limits committed in the technical plan;
  larger logical batches MUST be split rather than accepted as an unbounded
  provider response.
- **FR-057**: Semantic or quality drift that preserves the objective output
  contract MUST be handled through an internal supported-model descriptor
  quarantine or operator action unless a deterministic committed canary evaluation
  detects it; a single validation probe MUST NOT claim to infer semantic
  compatibility.
- **FR-058**: If an active provider begins returning objectively incompatible query
  embeddings, semantic retrieval MUST become visibly unavailable or degraded while
  lexical retrieval continues. The system MUST NOT silently use another profile;
  recovery requires compatible binding restoration, successful revalidation, or a
  gated transition.
- **FR-059**: Each committed canonical chunk embedding or searchable filter-payload
  change MUST atomically create versioned index-projection work. The default
  pgvector adapter MAY acknowledge that projection in the canonical transaction;
  external-style adapters consume it asynchronously.
- **FR-060**: The backend-neutral vector capability descriptor MUST declare
  supported dimension ranges, distance metrics, portable filter operations, batch
  limits, exact and accelerated modes, and consistency/readiness behavior.
  Activation MUST validate an embedding space against the selected adapter's
  descriptor.
- **FR-061**: This feature MUST activate only cosine-distance embedding spaces.
  Candidate scores MUST be cosine similarity in the inclusive range `[-1, 1]`,
  with higher values better, inclusive minimum-score thresholds, and deterministic
  chunk-identifier tie-breaking. Reduced-precision or quantized candidate paths
  MUST oversample and rerank by the canonical full-precision vectors before final
  thresholding and `topK`.
- **FR-062**: The portable vector filter and projection payload MUST cover
  workspace and embedding-space identity, source identifiers including unassigned
  documents, JSON metadata-containment semantics, retrieval eligibility, and
  expiry. Changes to any projected field MUST enqueue versioned projection work,
  while canonical hydration remains the final enforcement gate.
- **FR-063**: Conformance tests MUST deliver versioned upsert, supersede, metadata
  update, eligibility update, expiry update, and delete operations in order,
  duplicated, and out of order, and MUST verify that stale candidates cannot
  underfill valid `topK` results when enough eligible records exist.
- **FR-064**: Metrics MUST use bounded backend, route, dimension bucket, readiness,
  fallback, and outcome labels only. Workspace, profile, model, job, transition,
  and outbox identifiers MAY appear only in access-controlled logs or traces and
  MUST NOT be metric labels.
- **FR-065**: Implementing or selecting Pinecone or another non-PostgreSQL
  production vector backend remains out of scope and would require the
  constitution amendment mandated by the current PostgreSQL/pgvector principle,
  even though the neutral ports and conformance suite are delivered now.
- **FR-066**: Existing ingestion-settings reads and writes MUST continue returning
  and accepting the same active model, pending model, and supported four-model
  fields. When an older client echoes an active legacy model while changing
  unrelated settings, a value equal to the workspace's current active model MUST
  be treated as an unchanged embedding selection even if it is not in the current
  catalog; a different unsupported value MUST be rejected without starting a
  transition. Internal profile or embedding-space identifiers MUST remain private.
- **FR-067**: Embedding calls MUST resolve the current supported-model descriptor,
  provider, endpoint scope, and workspace credential explicitly; routing MUST NOT
  infer a provider from model-name prefixes. Declared document/query purpose and
  observed dimensions MUST flow through provider-neutral generation contracts,
  while provider adapters remain authoritative for task mapping and normalization.

### UI Tasks

- The provider settings experience must retain exactly the existing four embedding
  model choices and must not add custom model, requested-dimension, internal
  profile, or vector-backend controls.
- Changing a populated workspace must show a confirmation describing background
  replacement and continued active search.
- The existing active/pending model and cancellation presentation must remain
  compatible, and a failed transition must leave the active model visibly
  unchanged.
- The interface must preserve existing design tokens and clearly distinguish
  existing model-provider configuration from internal vector-backend details.

### Key Entities

- **Embedding Model Descriptor**: Internal capability metadata for one of the
  current four models, including expected/native dimensions and provider-declared
  vector semantics.
- **Embedding Space**: Immutable compatibility identity containing the
  provider implementation, opaque endpoint-scope fingerprint, model, dimensions,
  cosine semantics, document/query mapping, and vector-affecting options.
- **Workspace Embedding Profile**: An internal workspace binding between an
  embedding space and the existing provider/credential resolution path, with
  active, pending, blocked, or retired lifecycle status.
- **Workspace Embedding Transition**: The lifecycle record connecting active,
  pending, progress, failure, promotion, cancellation, and cleanup state.
- **Chunk Embedding Representation**: A full-precision vector for one canonical
  chunk revision in one embedding space.
- **Vector Index Work Item**: Durable, ordered, idempotent work that synchronizes a
  canonical vector representation to the configured vector adapter.
- **Vector Index State**: Backend-neutral readiness, lag, degradation, health, and
  rebuild status for an embedding profile and scope.

## Assumptions

- PostgreSQL and pgvector remain the default vector implementation and PostgreSQL
  remains the canonical application database.
- Pinecone and other external vector services are architectural compatibility
  targets only; no vendor adapter, vendor credentials UI, or vendor-specific
  deployment configuration is included in this feature.
- The supported product catalog remains
  `text-embedding-3-small`, `text-embedding-3-large`,
  `text-embedding-ada-002`, and `gemini-embedding-001`. Adding another model later
  may require a catalog/provider-adapter change, but MUST NOT require changes to
  vector ports, persistence contracts, transition orchestration, or retrieval.
- A workspace uses one active embedding profile for semantic retrieval; ensembles
  and cross-profile score fusion are out of scope.
- Automatic selection of the “best” embedding model and retrieval-quality
  benchmarking between models are out of scope.
- Existing lexical retrieval remains PostgreSQL-resident and continues to operate
  during vector transition or degradation.
- Public rollback and permanent multi-version retention are out of scope; prior
  profile data is retained only for bounded, safe asynchronous cleanup.
- This feature governs canonical document and query embeddings used for semantic
  retrieval. Ephemeral embeddings used only for chunk-boundary analysis, routine
  prefilters, or other non-indexed features must declare their purpose explicitly
  but are not automatically migrated into workspace retrieval profiles.
- Exact-search safety and approximate-recall thresholds will be established by
  representative benchmarks during planning and committed as documented operator
  limits before activation behavior ships.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the committed provider-conformance fixture matrix, all four current
  models resolve through the same provider-neutral generation contract and all
  malformed, missing-count, mixed-dimension, non-finite, and zero-vector fixtures
  are rejected before activation.
- **SC-002**: During transition tests covering upload, update, deletion, retry, and
  worker restart, semantic retrieval retains complete active-profile coverage
  until one atomic promotion; no query mixes active and pending profiles.
- **SC-003**: Promotion occurs only when 100% of eligible current document revisions
  and required index work are ready; cancellation or terminal failure leaves the
  prior active model and its complete semantic coverage unchanged.
- **SC-004**: In the committed `embedding-index-v1` benchmark environment and
  fixture matrix, every accelerated production route returns semantic candidates
  with p95 latency at or below one second for 100,000 workspace vectors and two
  seconds for 1,000,000 workspace vectors; recall is at least 98% without selective
  filters and at least 95% at the committed selective-filter case against exact
  search.
- **SC-005**: For exact-fallback profiles, activation is allowed only below the
  documented safety threshold and all operator surfaces identify the degraded mode.
- **SC-006**: The backend-neutral adapter conformance suite passes for both the
  default adapter and an in-memory external-style adapter, including capabilities,
  space preparation/reset, versioned upsert/supersession/delete, portable filtered
  search, score semantics, and health/readiness. Application reconciliation tests
  separately pass lag, retry, ordering, and scoped rebuild scenarios.
- **SC-007**: A full index can be rebuilt from canonical state in a clean environment
  with matching vector counts and no lost document identifiers.
- **SC-008**: Contract tests show existing settings API and SDK clients continue to
  read and write the same four embedding-model values and unrelated ingestion
  settings without new model, dimension, profile, or vector-backend fields.
- **SC-009**: Logs, metrics, traces, and audit tests contain no prompts, document
  content, chunk text, raw vectors, credentials, cookies, or connection strings.
- **SC-010**: In the committed `vector-projection-v1` environment, at a steady-state
  rate of 1,000 vector mutations per minute excluding explicit full rebuilds, 95%
  of durable vector-index work is acknowledged within 30 seconds of canonical
  commit and 99% within five minutes; delayed or failed work remains visible and
  retryable without changing canonical readiness.
