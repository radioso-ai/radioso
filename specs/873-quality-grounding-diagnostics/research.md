# Research: Quality Grounding Diagnostics

## Dedicated snapshot columns

**Decision**: Persist verdict plus four counts as nullable scalar columns on
`messages`, with one shared chat-boundary value type.

**Rationale**: The diagnostic belongs to the immutable assistant answer and needs
ordinary SQL predicates. Existing JSON remains useful for traces/evals but is not
a queryable Quality read model.

**Alternatives considered**: Querying `metadata_json` or audit events at request
time (rejected for performance and ambiguous history); adding a Quality table
(rejected because ownership belongs to the message).

## Completeness and integrity

**Decision**: Enforce all-null/all-present, recognized verdict, non-negative
integer counts, and `sourced + unsourced = total` in PostgreSQL.

**Rationale**: Runtime responses must never expose a partial diagnostic. Database
constraints protect every writer and make `grounding_verdict IS NOT NULL` a safe
completeness predicate.

**Alternatives considered**: Application-only validation (rejected because
migrations, tests, and future writers could bypass it).

## Historical source and precedence

**Decision**: The newest matching `chat.answer` or `chat.suspended` event wins by
`created_at DESC, id DESC`; validate only that event and never fall back.

**Rationale**: Both lifecycle events carry complete diagnostics. One deterministic
winner preserves lifecycle history without cherry-picking an older, more
convenient payload.

**Alternatives considered**: `chat.answer` only (loses suspended turns); newest
valid event (can resurrect stale data); request-time recovery (violates the read
model boundary).

## Quality filtering

**Decision**: Deduplicate verdicts, use `= ANY($n::text[])` for OR semantics, and
use count `> 0` / `= 0` predicates guarded by diagnostic completeness. AND the
three filter families with all existing filters.

**Rationale**: This mirrors existing signal/status patterns, preserves totals and
pagination, and makes false explicitly exclude unknown diagnostics.

**Alternatives considered**: Client-side filtering (breaks totals/pagination);
joins or unions (risk duplicate turns); JSON predicates (misses the durability
goal).

## Operator presentation

**Decision**: Put a compact evidence block under the existing Outcome/Action
badge. Show `N of N claims sourced`; add separate text warnings only for non-zero
unsourced or invalid counts; render `No supported claims` for zero-claim
`no_support`; render nothing for null.

**Rationale**: It explains the existing outcome without widening the table.
Separate labels preserve meaning without relying on color.

**Alternatives considered**: New column (too wide); percentage (misleading at
zero claims); an “unavailable” marker (can look like a failure).

## URL and filter UX

**Decision**: Add `groundingVerdict` CSV state plus positive-only URL booleans
`hasUnsourcedClaims=true` and `hasInvalidSources=true`. Put them in an expanded
Evidence section and existing applied-filter pills. Signal presets clear them.

**Rationale**: Operators most often seek failures; the public API still supports
false for automation. Existing route normalization provides shareable,
individually removable filters.

**Alternatives considered**: Tri-state UI booleans (more complex than the
operator job); local component state (not shareable).

## Index review

**Decision**: Add no grounding index in the first release.

**Rationale**: Quality queries already enter through the workspace-scoped
assistant-turn population and grounding is a secondary filter. The five-column
snapshot is narrow, and an index combining every filter family would be wasteful.

**Alternatives considered**: Individual count/verdict indexes (unlikely to be
selected after the existing workspace/role scan; adds write/storage cost).

## OpenAPI and downstream contracts

**Decision**: Update the existing quality schema/path registry modules, generate
backend OpenAPI, then sync SDK and MCP types from `backend/openapi.json`.

**Rationale**: This is the repository’s code-first contract workflow.

**Alternatives considered**: Hand-editing generated files or frontend-only types
(both create drift).

## Queue and observability impact

**Decision**: No queue or observability changes.

**Rationale**: There is no worker payload, AMQP handoff, retry, provider call, or
new operational failure mode. Existing chat audit events continue unchanged.
