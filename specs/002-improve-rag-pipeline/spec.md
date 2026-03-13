# Feature Specification: Universal Retrieval Quality Upgrade

**Feature Branch**: `002-improve-rag-pipeline`  
**Created**: 2026-03-13  
**Status**: Draft  
**Input**: User description: "Improve the RAG pipeline so query rewrite and reranking can support stronger retrieval settings with grounded results."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reliable Grounding Across Retrieval Profiles (Priority: P1)

An API client asks a question against previously ingested account documents while using a strict or broad retrieval settings profile. The system returns a grounded answer with citations instead of falling back to a no-results response when the answer is clearly present in the account's documents.

**Why this priority**: The feature only has value if retrieval remains reliable across realistic account settings profiles instead of working only for one narrow operating point.

**Independent Test**: Can be fully tested by ingesting a representative document set, enabling different retrieval settings profiles for one account, issuing known-answer chat queries, and verifying that the answers are grounded in the correct documents with usable citations.

**Acceptance Scenarios**:

1. **Given** an account with ingested documents containing the answer to a direct question and a strict retrieval profile enabled, **When** the client asks that question, **Then** the system returns an answer grounded in the account's documents and includes citations to the relevant retrieved content.
2. **Given** an account with ingested documents containing the answer to a follow-up question that depends on earlier conversation context, **When** the client asks the follow-up question in the same conversation, **Then** the system retrieves the intended content and returns a grounded answer without requiring the user to restate the missing context manually.

---

### User Story 2 - Broad Candidate Retrieval With Focused Final Context (Priority: P2)

An API client uses a high retrieval depth so the system can consider many candidate chunks, but still expects the final answer to be built from a small, focused set of the most relevant contexts.

**Why this priority**: Retrieval quality improves only if the system separates broad candidate gathering from strict final relevance decisions and can do so across different account configurations.

**Independent Test**: Can be fully tested by ingesting documents with partially overlapping topics, running chat queries under broad retrieval settings, and verifying that the final cited contexts are narrowed to the most relevant chunks even when many candidates are initially available.

**Acceptance Scenarios**:

1. **Given** an account with many candidate chunks that share related vocabulary, **When** the client asks a targeted question with high retrieval depth enabled, **Then** the system evaluates a broad candidate set and narrows it to a smaller final context set that is more relevant than the raw candidate ordering.
2. **Given** multiple retrieved chunks satisfy the same topic loosely but only a subset directly answers the question, **When** reranking is enabled, **Then** the final cited contexts favor the directly answer-bearing chunks over loosely related ones.

---

### User Story 3 - Predictable Fallback And Diagnostics (Priority: P3)

An operator enables stronger retrieval assistance for an account and needs the system to degrade predictably when rewrite or rerank steps fail, while still being able to tell whether the stronger retrieval pipeline actually ran.

**Why this priority**: More capable retrieval assistance increases the need for safe fallback behavior and clear operational evidence that the new pipeline is functioning as intended.

**Independent Test**: Can be fully tested by simulating rewrite or rerank failures, verifying that chat still completes safely, and confirming that the system records enough execution evidence to distinguish successful enhanced retrieval from fallback behavior.

**Acceptance Scenarios**:

1. **Given** the enhanced retrieval settings are enabled and the rewrite or rerank step cannot complete successfully, **When** the client submits a chat request, **Then** the system falls back to the safest available retrieval path without exposing internal failures to the client or fabricating unsupported answers.
2. **Given** the enhanced retrieval settings are enabled, **When** a chat request completes, **Then** the system records whether rewrite and rerank were applied, skipped, or fell back so operators can verify the retrieval path that was used.

### Edge Cases

- What happens when a follow-up question contains only referential language such as "that one" or "what about its limit?" and the intended referent exists only in earlier turns?
- How does the system handle cases where a strict similarity threshold would otherwise eliminate all candidates even though relevant content exists in the account's documents?
- What happens when multiple documents contain similar terminology but only one contains the exact answer-bearing passage?
- How does the system behave when query rewriting produces a worse retrieval query than the user's original wording?
- What happens when the conversation history is too long to send in full to the rewrite step?
- How does the system respond when the rewrite or rerank dependency is unavailable or returns unusable output?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP routes remain transport-only, chat orchestration remains responsible for conversation lifecycle and answer flow, retrieval services own rewrite/search/rerank/prompt preparation behavior, and persistence modules remain the only owners of database reads and writes.
- **Encapsulation Rule**: Chat route handlers and the chat orchestration service must not absorb retrieval ranking logic, prompt rewriting rules, or vector-candidate filtering policy. Persistence repositories must not absorb conversation-aware retrieval decisions.
- **New Seams Required**: The retrieval module must expose distinct focused seams for conversation-aware query rewriting, candidate retrieval preparation, candidate reranking, and final prompt context selection so each step can evolve independently and be tested in isolation.
- **Anti-Goals**: Do not push retrieval quality fixes into route handlers. Do not collapse rewrite, vector search, and rerank into one catch-all service. Do not require API contract changes to enable the stronger pipeline. Do not weaken account scoping or safe fallback behavior in order to boost recall.

## Retrieval Pipeline Semantics

1. Select the latest user message as the question to answer.
2. Select the relevant conversation context needed for retrieval preparation.
3. When query rewrite is enabled and useful, derive a standalone retrieval query from the latest message plus selected conversation context.
4. Execute first-pass account-scoped vector retrieval against stored chunks.
5. Apply the configured minimum vector similarity policy to the first-pass candidate set before reranking.
6. Prepare a deduplicated retrieved candidate set for reranking and final selection.
7. When reranking is enabled, reorder the candidate set by direct relevance to the retrieval query.
8. Select the final prompt context set from the reranked candidates, bounded by both relevance depth and answer context budget.
9. Build grounded answer inputs from the original user query plus the final prompt context set.
10. Generate the answer and citations from the final prompt context set.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST improve retrieval quality across a broad range of account retrieval settings profiles so grounded chat remains usable under both strict and broad retrieval configurations.
- **FR-002**: When query rewrite is enabled, system MUST derive a conversation-aware standalone retrieval query from the user's latest message and the relevant conversation context before vector retrieval begins.
- **FR-003**: The rewrite step MUST preserve the user's intent, carry forward omitted referential context when needed, preserve important names and terms, and avoid introducing unsupported facts or expanding the request beyond what the user asked.
- **FR-004**: The rewrite output MUST be retrieval-only and MUST be safe to discard whenever the system determines that rewriting is unnecessary, unusable, or lower confidence than the original wording.
- **FR-005**: System MUST continue to use the user's original chat message as the question being answered, even when a rewritten query is used to improve retrieval.
- **FR-006**: System MUST evaluate a broad candidate set during vector retrieval so that high final precision does not depend on the first-pass similarity ordering alone.
- **FR-007**: System MUST apply the configured minimum vector similarity policy consistently to first-pass vector candidates before reranking and final context selection occur.
- **FR-008**: Retrieved candidates MUST be deduplicated and normalized into a stable candidate set before final context selection.
- **FR-009**: System MUST apply reranking after candidate retrieval and before final prompt construction when reranking is enabled.
- **FR-010**: Reranking MUST be able to distinguish directly answer-bearing chunks from loosely related chunks that share vocabulary with the query and MUST rely on semantic relevance rather than keyword overlap alone.
- **FR-011**: System MUST reduce the final context set passed to answer generation to the most relevant subset of the retrieved candidates, bounded by both configured relevance depth and answer context budget.
- **FR-012**: When the configured final relevance depth exceeds the available answer context budget, system MUST drop lower-ranked contexts before answer generation instead of exceeding the context budget.
- **FR-013**: System MUST preserve account scoping across rewritten queries, vector retrieval, reranking, and citation generation so no account can retrieve another account's data.
- **FR-014**: If rewrite or rerank cannot produce usable output, system MUST fall back to the safest lower-assistance retrieval path available for that request rather than failing the chat request by default.
- **FR-015**: If retrieval still yields no usable context after all allowed fallback behavior, system MUST return the existing safe no-information response rather than fabricating an answer.
- **FR-016**: System MUST record execution evidence for each chat request indicating whether query rewrite and reranking were applied, skipped, or fell back, along with enough retrieval-stage detail to explain candidate reduction and final context selection.
- **FR-017**: System MUST make the strengthened retrieval behavior available through the existing retrieval settings mechanism without requiring a contract change to the chat or document endpoints.
- **FR-018**: System MUST preserve existing conversation continuity behavior so follow-up questions continue to resolve within the same account-scoped conversation.
- **FR-019**: System MUST support bounded conversation-context selection for retrieval preparation so long conversations remain usable without requiring every prior turn to be forwarded unchanged to rewrite or answer generation.
- **FR-020**: System MUST keep the enhanced retrieval pipeline testable through isolated unit tests for rewrite, thresholding, candidate preparation, rerank decisions, and context-budget selection plus end-to-end chat tests against representative documents.
- **FR-021**: System MUST define a repeatable retrieval evaluation procedure using a representative document corpus and human-verifiable known-answer queries so retrieval quality can be measured consistently over time.

### Key Entities *(include if feature involves data)*

- **Retrieval Settings Profile**: The account-scoped configuration that enables or disables rewrite and rerank behavior and controls candidate depth, thresholding, and final context depth for a chat request.
- **Rewritten Retrieval Query**: The retrieval-only restatement of the user's latest message, enriched with relevant conversation context so vector search can operate on a more precise standalone query.
- **Retrieved Candidate Set**: The account-scoped chunk collection returned by first-pass vector retrieval before final reranking and prompt selection.
- **Final Prompt Context Set**: The smaller, ordered subset of retrieved candidates chosen for answer generation and citation output after relevance refinement.
- **Retrieval Execution Record**: The per-request operational evidence showing whether rewrite and rerank ran successfully, were skipped by configuration, or fell back.
- **Evaluation Corpus**: The representative set of ingested documents and known-answer questions used to measure retrieval quality and regression risk over time.

## Assumptions

- The existing HTTP contract and account-scoped settings endpoints remain unchanged for this feature.
- The system may use conversation history selectively rather than sending the full raw conversation to every retrieval-improvement step.
- Retrieval quality is evaluated against representative known-answer document sets rather than requiring universal perfection across every possible corpus.
- Strengthening rewrite and rerank quality may also require changes to how retrieved candidates are prepared or filtered before final prompt construction.
- Existing document chunking remains available, but retrieval quality work may require clearer expectations for chunk continuity, chunk identity, and metadata preservation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a representative retrieval evaluation set spanning strict, moderate, and broad retrieval configurations, at least 90% of known-answer chat queries whose answers are explicitly present in the account's documents return a grounded answer with at least one citation instead of the no-information fallback.
- **SC-002**: In a representative follow-up-question evaluation set, at least 85% of referential follow-up questions retrieve the intended topic without requiring the user to restate the missing context manually.
- **SC-003**: In representative noisy-corpus evaluation runs, the median number of clearly irrelevant citations attached to a successful answer is reduced by at least 50% versus the current baseline retrieval path.
- **SC-004**: When rewrite or rerank assistance is unavailable during testing, 100% of affected chat requests still complete with either a grounded answer from fallback retrieval or the existing safe no-information response.
- **SC-005**: The representative retrieval evaluation procedure is repeatable enough that repeated benchmark runs on the same corpus produce materially consistent pass/fail outcomes for the same retrieval build.
