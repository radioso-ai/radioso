# Embedding Profiles Module

Embedding profiles own immutable embedding-space identity and workspace
transitions between those spaces. Start here when a change affects embedding
model compatibility, dimensions, canonical vector versions, rebuild fencing, or
promotion readiness. It also owns shared embedding generation and the
purpose-specific ports exposed to consumers.

## Boundaries

This module knows the provider-independent identity of an embedding space, the
active and pending spaces for a workspace, transition generations, and the
ports used to persist canonical vectors and projection work.

`QueryEmbeddingPort`, `DocumentEmbeddingPort`, and
`ClusteringEmbeddingPort` intentionally omit provider, model, dimensions,
normalization, and provider-task controls. `ProfileBoundEmbeddingPorts` resolves
those details from workspace/profile context and delegates to the provider
gateway. Retrieval, Documents, and chunking therefore cannot become accidental
general embedding APIs.

It does not know HTTP settings shape, provider SDK details, document-worker
orchestration, retrieval ranking, or a concrete vector backend. Provider
adapters implement `EmbeddingProviderPort`; database repositories implement the
storage ports; application composition wires both.

PostgreSQL `chunk_embeddings` is canonical. `vector_index_work` is a durable,
versioned projection log, and `vector_index_checkpoints` records each backend's
acknowledged high-water mark. A workspace transition may be promoted only after
the repository rechecks canonical coverage, generation-pinned work, target
quarantine state, and vector-backend readiness in the promotion transaction.

## Public Surface

- `public.ts`: contracts, identity and lifecycle rules, and vector validation.
- `contracts/embeddingProvider.ts`: provider-neutral generation contract.
- `contracts/embeddingConsumers.ts`: narrow query, document, and clustering
  consumer ports.
- `contracts/embeddingGeneration.ts`: internal generation gateway contract.
- `contracts/repositories.ts`: narrow persistence ports.
- `domain/embeddingSpace.ts`: immutable identity and compatibility.
- `domain/profileLifecycle.ts`: generation-safe transition rules.
- `services/embeddingVectorValidator.ts`: response validation and probing.
- `services/profileBoundEmbeddingPorts.ts`: profile-to-provider binding hidden
  behind the three consumer ports.
- `services/embeddingTransitionCoordinator.ts`: fixed-input validation,
  generation-fenced lifecycle commands, durable backfill handoff, and automatic
  promotion reconciliation.
- `services/embeddingProfileReadinessService.ts`: capability, projection-lag,
  exact-safety, and benchmark-qualified acceleration gates for activation.

Concrete Kysely repositories live in `backend/src/db/repositories/` and should
not be imported through this module's public surface.

## Tests

- `tests/unit/embeddingProfiles/`: identity, validation, and lifecycle rules.
- `tests/unit/embeddingProfiles/embeddingTransitionCoordinator.test.ts`:
  transition races, validation, backfill handoff, cancellation, promotion, and
  bounded failure semantics.
- `tests/unit/embeddingProfiles/embeddingProfileReadinessService.test.ts` and
  `tests/integration/vector-index-readiness.integration.test.ts`: exact versus
  accelerated readiness, checkpoint lag, compatibility, and activation gates.
- `tests/integration/embedding-profile-repositories.integration.test.ts`:
  migration constraints, canonical version ordering, transition promotion
  gates, projection tombstones, and checkpoint compare-and-swap behavior.
