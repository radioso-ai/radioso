# Research: Hybrid Retrieval

## Decision 1: Use PostgreSQL full-text search for the lexical retrieval leg

**Decision**: Implement the first lexical retrieval path with PostgreSQL full-text search over normalized chunk `search_text`, keeping pgvector as the existing semantic retrieval path.

**Rationale**: PostgreSQL full-text search is already available in the current storage stack, avoids introducing a new search service, and directly addresses the exact-match and literal-term retrieval gap that the current vector-only pipeline cannot cover well.

**Alternatives considered**:

- Introduce a separate BM25 engine or external search service immediately: rejected because it adds operational surface area before the value of hybrid retrieval is proven in Hivec.
- Keep retrieval vector-only and rely on reranking: rejected because exact strings, prices, dates, and locations remain weak candidates if they are never surfaced in the first place.

## Decision 2: Persist normalized hybrid-ingest metadata on chunk records

**Decision**: Extend chunk persistence with additive hybrid-ingest metadata, specifically normalized `search_text` plus a normalized structured-attribute payload used by retrieval, diagnostics, and prompt assembly.

**Rationale**: The chunk is already the retrieval unit used by vector search, citations, and prompt assembly. Persisting hybrid metadata on the same unit avoids introducing a parallel record model while keeping ingestion and retrieval aligned on one source of truth.

**Alternatives considered**:

- Introduce a separate hybrid-search record table immediately: rejected because it duplicates retrieval ownership before there is evidence the chunk-level seam is insufficient.
- Store attributes only in memory at ingest time: rejected because retrieval, diagnostics, and future re-use need persisted normalized values.

## Decision 3: Keep supported attribute filtering and boosting in the application layer

**Decision**: Apply supported attribute filtering and boosting in retrieval services after bounded semantic and lexical candidate generation instead of pushing complex per-request constraint scoring fully into SQL.

**Rationale**: The first release caps candidate counts tightly, so evaluating supported attributes in application code is predictable, easier to test, and easier to evolve than embedding confidence thresholds, fallback behavior, and mixed-family scoring directly in SQL.

**Alternatives considered**:

- Push all filtering and boosting into SQL: rejected because date-range overlap, confidence handling, and recall-safe fallback would become harder to reason about and more tightly coupled to storage queries.
- Ignore supported attributes until after reranking: rejected because the spec requires constraints to affect candidate quality, not just the final display.

## Decision 4: Represent operator controls as account-scoped attribute-family settings

**Decision**: Add account-scoped retrieval controls for each supported attribute family with `enabled` and participation `mode`, bounded to `boost_only` or `hard_filter`.

**Rationale**: Operators need meaningful control over supported retrieval behavior without being forced to design a schema. Family-level controls keep the settings model simple, auditable, and aligned with the approved scope.

**Alternatives considered**:

- Make supported attribute behavior globally fixed: rejected because different accounts may want different recall-versus-precision tradeoffs.
- Let operators define arbitrary new attribute names or extraction rules: rejected because that expands the product into a weak schema builder and significantly increases validation and support burden.

## Decision 5: Normalize supported attributes into one comparison form per family

**Decision**: Normalize supported attributes and parsed query constraints into one comparison form per supported family before retrieval logic runs.

**Rationale**: Dates, prices, currencies, and locations need consistent comparison rules or hard filters will exclude valid matches and soft boosts will be noisy. A family-specific normalization seam keeps this explicit and testable.

**Alternatives considered**:

- Compare raw extracted strings directly: rejected because equivalent values such as formatting variants or currency labels would not match reliably.
- Defer normalization to the LLM or reranker: rejected because filtering and boosting happen before answer generation and need deterministic behavior.

## Decision 6: Keep hard filtering conservative and confidence-gated

**Decision**: Allow hard filters only when both the parsed query constraint and the stored supported attribute values reach explicit confidence thresholds; otherwise degrade to boost-only behavior.

**Rationale**: False exclusions are more damaging than imperfect ranking in the first release. Conservative confidence gating preserves recall and matches the approved fallback-first product shape.

**Alternatives considered**:

- Always hard-filter whenever a supported literal appears: rejected because ambiguous dates, vague locations, and partial money values would over-prune candidates.
- Never hard-filter: rejected because some queries need precise exclusion behavior to meet the product goal.

## Decision 7: Expose retrieval information through additive chat response metadata

**Decision**: Make bounded retrieval information available to the admin UI through additive chat response metadata and matching stream completion metadata, rather than building a separate log-inspection workflow.

**Rationale**: The operator-facing chat experience already owns the query lifecycle. Additive response metadata keeps diagnostics close to the executed query, minimizes UI plumbing, and avoids forcing the frontend to depend on audit-log browsing to explain one answer.

**Alternatives considered**:

- Build a separate audit-events admin screen first: rejected because it expands scope into an analytics surface and makes per-answer inspection slower.
- Keep diagnostics backend-only: rejected because the approved spec explicitly requires product-visible retrieval information.

## Decision 8: Preserve the current chat and citation flow with additive payload changes only

**Decision**: Keep the existing chat request flow and citation behavior intact, making only additive payload changes needed for retrieval information.

**Rationale**: Retrieval quality is the feature goal, not a chat UX redesign. Additive response fields are the lowest-risk way to support the new operator-facing diagnostic surface while preserving current answer and citation behavior.

**Alternatives considered**:

- Create a separate retrieval-debug endpoint and leave chat responses unchanged: rejected because it splits one answer flow across multiple client requests and weakens traceability.
- Redesign the chat message model around retrieval diagnostics: rejected because it expands far beyond the approved scope.

## Decision 9: Cover the feature with backend-first TDD plus retrieval benchmarks

**Decision**: Start with failing backend tests for normalization, lexical retrieval, candidate merge, constraint parsing, fallback behavior, settings, and retrieval-info payloads, then update benchmark and frontend verification coverage.

**Rationale**: Most delivery risk is in the retrieval and persistence behavior. Backend-first TDD and benchmark regression protection are the most reliable way to keep the hybrid pipeline correct while preserving current chat behavior.

**Alternatives considered**:

- Build the settings and chat UI first: rejected because the frontend contract depends on backend retrieval decisions and payload shape.
- Rely on manual retrieval spot checks: rejected because the feature’s value depends on repeatable benchmark and regression coverage.
