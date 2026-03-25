# Research: Document Search

## Decision 1: Use a dedicated `POST /document/search` operation plus separate history/replay reads

**Decision**: Model live search as a dedicated POST operation and keep browse/list separate. Add dedicated read endpoints for search history listing and replay by search ID rather than overloading the existing document list endpoint.

**Rationale**: The feature requires ranked discovery, bounded filters, replay identity, and diagnostics correlation. Those all fit a first-class search operation better than a `GET /document?q=` browse variant. History reads are semantically different from live search execution and should remain distinct.

**Alternatives considered**:
- Extend `GET /document/` with a `q` parameter: rejected because it conflates browse and ranked search semantics.
- Put search under chat/history routes: rejected because the feature is document discovery, not conversation history.

## Decision 2: Persist search history as audit-event-backed snapshots

**Decision**: Reuse `audit_events` with a new `event_type` for document search, storing bounded snapshot metadata in `metadata_json` for history listing and replay.

**Rationale**: The repo already uses audit events to durably associate replayable diagnostics with user-visible history. Search history is similarly append-only, workspace-scoped, and replay-oriented. Reusing audit events avoids a new table while preserving traceability.

**Alternatives considered**:
- Add a dedicated `document_search_runs` table: rejected for v1 because audit events already fit the access pattern and reduce schema surface.
- Store only the query and recompute on replay: rejected because the spec now explicitly requires snapshot replay semantics.

## Decision 3: Replay returns the stored snapshot, not recomputed results

**Decision**: Reopening a historical search returns the stored summary, stored ranked result page, and trace availability for that search execution. Re-running the same query is a separate fresh search action.

**Rationale**: This makes historical review truthful when documents change or disappear later, and it keeps replay latency low because it does not invoke retrieval again.

**Alternatives considered**:
- Recompute current results on replay: rejected because it breaks the historical-review promise.
- Hybrid replay that silently mixes stored and recomputed data: rejected because it makes debugging ambiguous.

## Decision 4: Reuse the shared `RetrievalTrace` contract with search-specific stage participation

**Decision**: Document search emits the existing `RetrievalTrace` contract and uses the existing graph mental model. Search-specific runs omit or mark non-applicable chat-only stages as skipped or unavailable.

**Rationale**: The current trace contract is already generic enough to carry stage graphs, statuses, timings, and bounded inputs/outputs. Reusing it keeps diagnostics consistent across chat and search while avoiding a second trace dialect.

**Alternatives considered**:
- Create a parallel `DocumentSearchTrace` top-level contract: rejected because it increases long-term drift risk.
- Force search to fabricate chat outcomes: rejected because it distorts the meaning of the trace.

## Decision 5: Aggregate chunk relevance into document results in a dedicated search service

**Decision**: Reuse existing retrieval signals to gather chunk candidates, then aggregate them into document-level ranked results in a focused document-search orchestration layer.

**Rationale**: The system already has lexical/vector retrieval and bounded trace assembly. A dedicated search service can reuse those signals without overloading chat orchestration or route handlers.

**Alternatives considered**:
- Title-only or metadata-only filtering in the document repository: rejected because it ignores the main retrieval value of the system.
- Put document ranking logic inside `documentRoutes.ts`: rejected by the modularity rules and would create a god route.

## Decision 6: Bound snapshots to the returned result page plus explanation data

**Decision**: Persist the exact result page returned to the caller, including document summaries, scores/order, match evidence, and related trace identifiers, rather than trying to snapshot the entire possible corpus result set.

**Rationale**: The user-visible contract is page-oriented and bounded. Storing exactly what the caller saw is enough for truthful replay while keeping audit payloads bounded.

**Alternatives considered**:
- Persist the entire ranked corpus: rejected because payload growth is unbounded and unnecessary for the replay goal.
- Persist only IDs and rerank live on replay: rejected because that violates snapshot semantics.

## Decision 7: Extract search presentation out of `documents-view.tsx`

**Decision**: Split top-bar search state, result rendering, and replay/diagnostics affordances into focused components or hooks instead of continuing to grow `documents-view.tsx`.

**Rationale**: The existing file already owns CRUD, import, pagination, edit/view dialogs, and deletion flows. Search plus replay plus diagnostics would make it materially harder to reason about without extraction.

**Alternatives considered**:
- Keep all search logic in `documents-view.tsx`: rejected because the file is already large and would absorb too many unrelated concerns.
