# Feature Specification: Structured Lexical Query Plans

**Feature Branch**: `053-lexical-query-plan`
**Created**: 2026-04-28
**Status**: Draft
**Input**: User description: "Add structured LLM-produced lexical query plans for Radioso retrieval. The LLM should produce validated alternatives such as terms, phrases, should-groups, exclusions, and multiple lexical search options rather than raw backend-specific OR syntax. Radioso should compile the plan into the active lexical backend, keep current Postgres lexical search as the first implementation, preserve a backend-agnostic lexical search port for future BM25 backends, expose diagnostics for the generated plan and executed branches, and avoid custom BM25 implementation or immediate OpenSearch/Elasticsearch migration."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Retrieve exact alternatives from one user question (Priority: P1)

As an operator responsible for answer quality, I want Radioso to search several exact lexical alternatives from one user question so that relevant documents are found when users ask with aliases, phrase variants, acronyms, or related literal wording.

**Why this priority**: This is the core user value. The current lexical path treats rewritten lexical text as plain text, so alternatives such as quoted phrases and OR-style choices do not reliably increase recall.

**Independent Test**: Can be tested by sending a query whose relevant document uses one of several equivalent exact phrases and verifying retrieval includes the relevant chunk through the lexical path before answer generation.

**Acceptance Scenarios**:

1. **Given** a workspace with a ready document containing "reset token" but not "forgot password", **When** the user asks about forgotten passwords and the rewrite step proposes "forgot password" and "reset token" as lexical alternatives, **Then** lexical retrieval searches the alternatives and includes the "reset token" chunk in the candidate set.
2. **Given** a query that benefits from phrase matching, **When** the rewrite step marks a phrase as an exact lexical phrase, **Then** Radioso preserves the phrase intent when compiling the lexical search for the active backend.
3. **Given** a query with several names or identifiers, **When** the rewrite step produces multiple lexical search options, **Then** Radioso runs bounded lexical branches for those options and merges the resulting chunks with semantic candidates.

---

### User Story 2 - Understand what lexical alternatives were searched (Priority: P2)

As an operator debugging an answer, I want diagnostics to show the structured lexical plan and the executed lexical branches so I can tell whether weak retrieval came from bad rewriting, missing documents, backend limitations, or later candidate selection.

**Why this priority**: Better lexical recall is hard to tune unless operators can inspect what the system actually searched.

**Independent Test**: Can be tested by running a chat request with retrieval diagnostics enabled and verifying the response metadata identifies the lexical plan, each executed lexical branch, candidate counts, and fallback behavior without exposing unsafe raw model output as executable syntax.

**Acceptance Scenarios**:

1. **Given** a successful retrieval request with structured lexical alternatives, **When** diagnostics are inspected, **Then** they include the normalized lexical plan and a bounded list of executed lexical branches.
2. **Given** a lexical plan that is rejected or simplified, **When** diagnostics are inspected, **Then** they explain that fallback behavior was applied and show the fallback query used for retrieval.
3. **Given** multiple lexical alternatives that return duplicate chunks, **When** diagnostics are inspected, **Then** the system reports branch-level counts and final merged counts without double-counting the same chunk as separate evidence.

---

### User Story 3 - Keep lexical retrieval backend-swappable (Priority: P3)

As a platform maintainer, I want Radioso to represent lexical intent independently from backend query syntax so that BM25-compatible search can be piloted later without rewriting chat orchestration or prompt policy.

**Why this priority**: The product should gain structured lexical search now while avoiding premature commitment to a custom BM25 engine or a new search service.

**Independent Test**: Can be tested by replacing the lexical backend in a controlled test with a stub that receives normalized lexical plan data and verifying retrieval orchestration does not depend on backend-specific query strings.

**Acceptance Scenarios**:

1. **Given** the active backend is the existing PostgreSQL lexical search path, **When** Radioso receives a structured lexical plan, **Then** the plan is compiled into a safe query form supported by that backend.
2. **Given** a future backend that supports BM25 ranking, **When** it implements the lexical retrieval contract, **Then** it can consume the same normalized lexical plan without changing chat route handlers or high-level retrieval orchestration.
3. **Given** the LLM emits backend-specific syntax such as raw OR operators, **When** Radioso validates the rewrite output, **Then** the syntax is treated as data to normalize or reject rather than trusted executable query syntax.

### Edge Cases

- What happens when the LLM returns malformed lexical plan JSON or omits the structured plan entirely?
- What happens when the lexical plan contains too many alternatives or branches for the configured retrieval budget?
- What happens when alternatives contain only stop words, punctuation, or empty strings after normalization?
- How does the system handle phrase, exclusion, and optional-term intent when the active backend cannot represent one of those operations exactly?
- What happens when all structured lexical branches return zero candidates but the original query has searchable terms?
- How does the system prevent a broad generated alternative from overwhelming exact-match results?
- How are duplicate chunks merged when several lexical branches match the same chunk?
- How are non-English queries handled when lexical alternatives contain accents, casing differences, or language-specific terms?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend runtime prompt templates introduced or revised for this feature MUST live under `backend/prompts/`.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated if configuration changes are introduced.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Query rewrite prompt assets own model instructions; rewrite parsing and validation own conversion from model output to normalized lexical intent; lexical compilation owns backend-specific query construction; lexical search infrastructure owns persistence/search execution; retrieval orchestration owns stage sequencing and candidate merging only; chat transport owns request/response flow only.
- **Encapsulation Rule**: Chat route handlers MUST NOT parse, validate, compile, or rank lexical query plans. High-level retrieval pipeline services MUST remain orchestration-only and MUST delegate lexical plan validation, branch budgeting, and backend compilation to focused modules.
- **New Seams Required**: Introduce a normalized lexical query plan shape, a validation/normalization helper for LLM rewrite output, a lexical branch budget policy, a backend compilation seam under the lexical search adapter, and diagnostics formatting that presents plan intent separately from executed backend query details.
- **Anti-Goals**: Do not build a custom BM25 engine. Do not migrate to OpenSearch or Elasticsearch in this feature. Do not let raw LLM search syntax execute directly. Do not replace semantic retrieval. Do not add lexical ranking logic to chat route handlers. Do not make the query rewrite prompt responsible for knowing every backend's query language.
- **Contract Stability Rule**: Do not change the retrieval pipeline stage contracts or public chat/retrieval API contracts for this feature. Structured lexical plan support must fit behind existing orchestration boundaries through additive internal metadata and lexical-search adapter behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support a structured lexical query plan from the query rewrite step that can represent required terms, optional terms, exact phrases, exclusions, and multiple alternative lexical search options.
- **FR-002**: System MUST continue to support the existing plain lexical query field as a fallback when no valid structured lexical plan is available.
- **FR-003**: System MUST validate and normalize model-produced lexical plan data before any search backend receives it.
- **FR-004**: System MUST reject, trim, or simplify lexical plans that exceed configured branch, term, phrase, or length limits before retrieval executes.
- **FR-005**: System MUST treat raw Boolean-like syntax from the LLM as untrusted input, not as directly executable backend query language.
- **FR-006**: System MUST compile the normalized lexical plan into the active lexical backend's supported search behavior while preserving intent as closely as that backend allows.
- **FR-007**: System MUST run structured lexical alternatives as bounded lexical retrieval branches and merge their candidates with semantic candidates using existing candidate provenance rules.
- **FR-008**: System MUST deduplicate chunks returned by multiple lexical alternatives while preserving provenance that identifies lexical participation.
- **FR-009**: System MUST degrade safely to existing lexical retrieval behavior when structured plan parsing, validation, or backend compilation cannot produce a useful search.
- **FR-010**: System MUST include the normalized lexical plan, executed lexical branches, candidate counts, and fallback reasons in retrieval diagnostics and trace data.
- **FR-011**: System MUST keep lexical search backend contracts independent from one backend's query syntax so a future BM25-compatible implementation can be added behind the same retrieval boundary.
- **FR-012**: System MUST update runtime rewrite prompt assets under `backend/prompts/` so the LLM is instructed to produce structured lexical intent rather than backend-specific query strings.
- **FR-013**: System MUST keep runtime conversational answer copy generated by the LLM and MUST NOT add hard-coded assistant/chat response strings for this feature.
- **FR-014**: System MUST update operator-facing retrieval documentation if diagnostics, rewrite behavior, or tuning guidance changes.
- **FR-015**: System MUST preserve existing chat answer and citation contracts except for additive retrieval diagnostics fields.
- **FR-016**: System MUST cover backend behavior with TDD, including valid plans, malformed plans, over-budget plans, fallback behavior, duplicate merging, diagnostics, and backend compilation for the current lexical search implementation.
- **FR-017**: System MUST preserve existing retrieval pipeline stage contracts; feature behavior MUST be introduced behind the current query rewrite, lexical search, candidate merge, and diagnostics seams without requiring callers to use a new retrieval pipeline interface.

### Key Entities

- **Lexical Query Plan**: Normalized representation of lexical search intent generated from model output. Includes alternative search options, required terms, optional terms, exact phrases, exclusions, and limits applied during validation.
- **Lexical Search Option**: One bounded executable branch within a lexical query plan. Represents one search path that may combine required terms, optional terms, and phrases.
- **Lexical Execution Branch**: The backend-executed form of one lexical search option, including candidate counts, fallback status, and diagnostics-safe execution summary.
- **Retrieval Candidate Provenance**: Existing candidate metadata extended to show which semantic or lexical sources contributed to a chunk after deduplication.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 90% of structured lexical plan test cases execute without falling back when the plan is valid and within configured limits.
- **SC-002**: Exact-alternative benchmark cases that currently require OR-style lexical behavior retrieve the expected relevant chunk in the lexical candidate set at least 80% of the time.
- **SC-003**: Malformed or over-budget lexical plans fall back to safe existing lexical behavior in 100% of covered tests without failing the chat request.
- **SC-004**: Retrieval diagnostics identify the normalized lexical plan, executed branch count, branch candidate counts, and fallback reason for 100% of covered structured-plan retrieval scenarios.
- **SC-005**: The feature introduces no breaking changes to existing chat answer, citation, or stream-completion contracts; any payload changes are additive.
- **SC-006**: Backend tests cover all functional requirements that affect parsing, validation, search execution, fallback, candidate merging, and diagnostics before implementation is considered complete.
- **SC-007**: Type checking confirms existing retrieval pipeline stage interfaces remain source-compatible for current callers.
