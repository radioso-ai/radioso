# Research: Quality Resolution and Eval Learning Loop

## Structured triage compatibility

- **Decision**: Add `resolution: { reason, note }` and `expectedVersion` while
  continuing to parse the old `reason` property. The old field is stored only
  as legacy free text and is never converted to a typed reason.
- **Rationale**: Existing clients remain syntactically compatible and historical
  text is not misclassified. Structured clients receive strict state-specific
  validation. Compatibility-only terminal rows appear as `unspecified`.
- **Alternatives considered**: Rejecting old requests breaks clients; guessing a
  typed reason violates multilingual and anti-keyword rules.

## Concurrency token

- **Decision**: Absence of a triage row is version `0`; the first accepted write
  creates version `1`; each accepted transition increments by one. A stale write
  returns `409` plus the current record.
- **Rationale**: Integer versions are explicit, stable, and convenient in the
  SDK. One conditional upsert makes first-write races and updates consistent.
- **Alternatives considered**: timestamps are display data and may collide;
  ETags add HTTP ceremony without improving SDK ergonomics.

## Transition history

- **Decision**: Persist an immutable `assistant_answer_triage_transitions` row in
  the same database transaction as the current-row update. Store structured
  reason and linked Eval case id, never the note.
- **Rationale**: Current state remains fast while accepted transitions cannot
  lose their history. Atomic persistence is stronger than reconstructing state
  from general audit logs.
- **Alternatives considered**: only using the mutable row loses reopen history;
  an after-the-fact audit call can fail after the state write.

## Eval message association and idempotency

- **Decision**: Add a dedicated workspace/message-to-case table with a primary
  key on `(workspace_id, assistant_message_id)` and a unique `case_id`. A
  focused Eval service prepares snapshot data and asks the repository to create
  snapshot, case, and association atomically; uniqueness races return the winner.
- **Rationale**: The association—not an immutable snapshot—is stable identity.
  It supports deletion/recreation without a generic origin framework.
- **Alternatives considered**: scanning snapshots is unbounded; making snapshots
  unique prevents explicit recapture; client-side capture/create races.

## Quality verification projection

- **Decision**: Eval exposes a batch method keyed by source message ids. It joins
  associations, cases, and the case's current `last_run_id` in one query and
  returns a neutral projection. Quality never reads Eval tables.
- **Rationale**: Page enrichment is bounded and the interpretation of Eval case
  and run state stays in Eval.
- **Alternatives considered**: N+1 lookups and Quality-side joins both violate
  the approved boundary.

## Resolution breakdown semantics

- **Decision**: Count current terminal rows by state/reason where `closed_at`
  falls in the active 7/30-day window. Reopened rows are absent; compatibility
  or historical rows without a typed reason use `unspecified`. Click-through
  uses explicit `resolutionFrom`/`resolutionTo` filters; existing `from`/`to`
  continue to mean assistant-message creation time.
- **Rationale**: Counts describe current closed work and click through to the
  same list predicate.
- **Alternatives considered**: counting transition events double-counts
  reclosed turns and leaves reopened work in the report. Reusing `from`/`to`
  would make breakdown counts disagree with old turns closed inside the window.

## Observability

- **Decision**: Emit structured operational logs/audit evidence for transition
  acceptance/conflict and Eval association create/find with workspace-safe ids,
  state, version, reason code, and case id. Do not add metrics.
- **Rationale**: These state-changing races need support correlation; reason
  counts already provide the useful aggregate. Notes and conversation content
  remain excluded.
- **Alternatives considered**: high-cardinality per-message metrics add cost
  without operator value.

## Message queue impact

- **Decision**: No queue changes.
- **Rationale**: All contracts are synchronous Quality/Eval HTTP and PostgreSQL
  state. Document dispatch, AMQP payloads, retry semantics, worker tests, and
  queue documentation are unaffected.
