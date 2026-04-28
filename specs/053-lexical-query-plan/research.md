# Research: Structured Lexical Query Plans

## Decision 1: Use existing retrieval subqueries as the execution shape

**Decision**: Normalize LLM lexical alternatives into existing `retrievalSubqueries` rather than adding a new retrieval pipeline stage contract.

**Rationale**: The pipeline already supports multiple retrieval branches with separate semantic and lexical queries. Reusing that shape satisfies the user's no-contract-change constraint and keeps candidate retrieval, trace assembly, and merge behavior aligned with existing code.

**Alternatives considered**:

- Add a new `lexicalQueryPlan` field to retrieval pipeline stage results: rejected because it changes the stage contract.
- Encode raw OR syntax in a single lexical query: rejected because backend-specific syntax is fragile and hard to validate.

## Decision 2: Add focused domain normalization for lexical alternatives

**Decision**: Add a retrieval-domain helper that parses and normalizes lexical alternatives from plain lexical query strings and subquery strings.

**Rationale**: Query rewrite service should not grow ad hoc parsing logic, and chat orchestration should stay unaware of lexical syntax. A pure helper is easy to test and keeps behavior reusable for future BM25 backends.

**Alternatives considered**:

- Put parsing inside `QueryRewriteService`: rejected because the service is already responsible for rewrite policy and context handling.
- Put parsing inside `PgLexicalSearch`: rejected because by that point the pipeline has already decided branch structure.

## Decision 3: Keep PostgreSQL as the first lexical backend

**Decision**: Improve current PostgreSQL full-text compilation without introducing BM25 infrastructure in this feature.

**Rationale**: The feature goal is structured lexical intent and safer alternatives, not a search engine migration. PostgreSQL can support web-search-style query parsing for phrases and OR-like behavior, which improves the current backend while keeping operations stable.

**Alternatives considered**:

- Add ParadeDB/`pg_search`: rejected for this feature because it introduces extension and deployment questions.
- Add OpenSearch/Elasticsearch: rejected because it introduces a second datastore and sync path.
- Build custom BM25: rejected because production search requires far more than the BM25 formula.

## Decision 4: Diagnostics remain additive and contract-stable

**Decision**: Use existing subquery and branch diagnostics to show lexical alternatives, adding only internal trace/detail data if needed.

**Rationale**: Operators need observability, but the user explicitly asked to avoid retrieval pipeline contract changes. Existing retrieval subquery and branch diagnostics already explain multiple lexical branches.

**Alternatives considered**:

- Add new public response fields for lexical plans: rejected for this feature to keep contracts stable.
- Hide alternatives entirely: rejected because debugging lexical recall would remain difficult.
