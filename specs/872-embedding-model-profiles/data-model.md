# Data Model: Generic Embedding Spaces

## `embedding_spaces`

Immutable compatibility identity shared by workspace profiles.

- `id`
- `fingerprint` (unique)
- `provider_implementation`
- `endpoint_scope_fingerprint` (opaque, non-secret)
- `model`
- `dimensions` (1–16,000)
- `distance` (`cosine`)
- `normalization`
- `document_task`, `query_task`
- `vector_options` (bounded JSON)
- `provider_model_version`
- `validation_state` (`validated`, `quarantined`)
- timestamps

Credentials and raw endpoint strings are forbidden.

## `workspace_embedding_profiles`

Internal binding of one workspace to one immutable space and its existing
provider/credential resolution path.

- `id`, `workspace_id`, `embedding_space_id`
- `provider_binding_version`
- `state` (`active`, `pending`, `blocked`, `retired`)
- `generation`
- timestamps

Constraint: one active and at most one pending profile per workspace.

## `workspace_embedding_transitions`

- `id`, `workspace_id`
- `from_profile_id`, `to_profile_id`
- `expected_generation`
- `state` (`validating`, `building`, `ready`, `promoted`, `cancelled`, `failed`,
  `cleaning`, `complete`)
- eligible/embedded/projected counts
- sanitized failure code/detail
- start/promotion/cancel/cleanup timestamps

Promotion compare-and-swaps `expected_generation` after rechecking coverage and
readiness. No internal ID becomes a public selectable resource.

## `chunk_embeddings`

Canonical, rebuildable full-precision representation.

- `chunk_id`, `workspace_id`, `document_id`, `document_revision`
- `embedding_space_id`
- `embedding` (`vector` without fixed typmod)
- `dimensions`
- `canonical_version`
- `tombstoned_at`
- timestamps

Unique active representation per chunk revision and space. Stored dimensions must
equal the referenced immutable space.

## Durable document jobs

Extend the existing durable job record for the embedding-only kind:

- `target_profile_id`
- `target_embedding_space_id`
- `document_revision`
- `workspace_profile_generation`
- `purpose`

Profile-aware uniqueness permits active and pending work for the same canonical
revision. Queue messages still carry only the authoritative job ID.

## `vector_index_work`

- monotonic `version`
- logical workspace/space/chunk/revision IDs
- operation (`upsert`, `supersede`, `delete`)
- full vector plus portable projected filter payload
- status, attempt, lease, available-at, acknowledged-at
- durable tombstone marker

Canonical vector/filter mutation and work insertion share a transaction. A mutation
with a lower version cannot overwrite or resurrect newer state.

## `vector_index_checkpoints`

- adapter key and logical scope
- embedding-space/profile identity
- acknowledged high-water mark
- readiness (`accelerated`, `building`, `stale`, `unavailable`, `exact_fallback`)
- route, canonical/projected counts, lag
- rebuild generation/state
- sanitized last error and timestamps

## Legacy Compatibility

Current chunk embedding columns and settings fields remain during this release. A
background reconciler materializes profiles from stored vectors and shadow-validates
before workspace cutover. No startup bulk copy and no destructive legacy cleanup occur.

