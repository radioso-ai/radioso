# Research: Model and Embedding Usage Visibility

## Decision 1: Preserve the existing immutable ledger

**Decision**: Extend `usage_events`; do not introduce a separate telemetry or
reporting store.

**Why**: The recorder already captures the provider attempt, its account and
workspace lineage, its time, status, and usage quality. A read model can derive
the two dashboard views from that durable source without splitting the audit
trail or adding replication work.

**Alternatives considered**:

- A new analytics table: rejected because it duplicates the durable event
  source and makes retries, deletes, and reconciliation harder to explain.
- Client-side aggregation: rejected because it cannot safely enforce account
  scope or correctly partition an event after message/conversation deletion.

## Decision 2: Use a persisted kind with an honest historical fallback

**Decision**: Add `event_kind` with `model`, `embedding`, and `unknown`.
Recorder methods always write model or embedding. The migration classifies old
rows only when their existing idempotency prefix, embedding-item lineage, or
positive vector count provides evidence; every other old row becomes unknown.

**Why**: A historical zero-vector failed embedding cannot be distinguished from
a failed model call from the old columns alone. `unknown` is more useful and
more accurate than guessing, while future writes are unambiguous.

**Alternatives considered**:

- Treat `vector_count = 0` as model: rejected because failed embeddings are
  commonly zero-vector attempts.
- Classify from operation names alone: rejected because operation names are
  product metadata rather than a durable event type and are not exhaustive.
- Leave the field nullable: rejected because each reporting row needs a stable
  display/filter type; an explicit unknown is clearer than a null convention.

## Decision 3: Split message totals by kind

**Decision**: A message row has three subtotals: model, embedding, and
unknown-historical. Reasoning coverage and derived visible output operate only
on the model subtotal.

**Why**: Retrieval query embeddings carry user-message lineage. They belong to
the visitor turn, but embeddings do not have completion or reasoning tokens and
therefore cannot participate in model-output arithmetic.

**Alternatives considered**:

- Move all message-linked embeddings to Internal operations: rejected because
  it hides a material part of the per-turn work from the person investigating
  that message.
- Treat absent embedding reasoning as unavailable model reasoning: rejected
  because it makes ordinary retrieval-backed messages look incomplete.

## Decision 4: Two narrow account-reporting endpoints

**Decision**: Add session-authenticated `GET /api/v1/account/usage/messages`
and `GET /api/v1/account/usage/internal-operations` endpoints.

**Why**: Message rows are aggregates while internal rows are individual ledger
attempts, so a discriminator-based response would create a broad, ambiguous
schema. Two endpoints keep clients and OpenAPI precise.

**Alternatives considered**:

- One endpoint with a `view` parameter and union response: rejected because
  pagination, cursor shapes, and fields differ materially.
- Extend trends: rejected because trends are time buckets of succeeded usage;
  they are not a diagnostic attempt ledger.

## Decision 5: Exact classification and keyset pagination

**Decision**: A Messages row includes an event only if it joins to a `user`
message, its conversation source is neither `authenticated_chat` nor
`workbench_replay`, and its surface is not `eval`. Every other event is
Internal. Message grouping/ranking happens before pagination. Cursors use
`(lastOccurredAt, messageId)` for messages and `(occurredAt, eventId)` for
internal events.

**Why**: It makes test/replay/eval activity visible without letting it appear
as visitor traffic, and prevents duplicate or missing message groups at page
boundaries.

## Decision 6: Privacy comes from response construction

**Decision**: The repository selects only an explicit reporting allowlist and
the response mapper exposes only that read model.

**Why**: `usage_events` also holds fields that can carry provider request or
error detail. A whitelisted row shape prevents a future `SELECT *` or object
spread from leaking message content, request IDs, idempotency keys, or error
values.

## Decision 7: Keep directive-coherence in its existing generic model path

**Decision**: Thread a narrowly named workspace/agent invocation context from
`AuthoredDirectiveService` through the directive-coherence checker metadata to
the server-side conversation-model gateway. The generic model gateway remains
agnostic of Radioso persistence outside its opaque metadata input.

**Why**: The current synthetic workspace identifier violates the ledger's
foreign key and the recorder intentionally swallows observational failures.
Passing actual context lets the existing inference pipeline write an internal
usage event without turning the generic conversation contract into a database
contract.

## Decision 8: Bounded filters and query plan

**Decision**: Detailed views use inclusive UTC date-only filters, a maximum
90-day range, a default page of 50, and a maximum page of 100. Add the
account/time/id index required for the internal keyset scan, then inspect the
message and internal query plans against integration data before closing the
database work.

**Why**: These limits keep the diagnostic dashboard responsive and limit the
amount of operational metadata returned in one request while preserving a
practical investigation window.
