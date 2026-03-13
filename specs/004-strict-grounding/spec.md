# Feature Specification: Strict Grounding

**Feature Branch**: `004-strict-grounding`  
**Created**: 2026-03-14  
**Status**: Draft  
**Input**: User description: "Make retrieval similarity threshold a hard floor for document-grounded chat, modestly raise default topK, and add regression coverage so out-of-corpus questions refuse instead of answering from model knowledge."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Refuse Unsupported Questions (Priority: P1)

As a user asking a question that is not covered by my uploaded documents, I want
the assistant to refuse rather than answer from general model knowledge, so I
can trust that answers come only from my document set.

**Why this priority**: Trust in document-grounded chat is the core product
promise. If unsupported questions receive generic answers, the system becomes
unreliable even when retrieval appears to succeed.

**Independent Test**: Can be fully tested by asking an out-of-corpus question
against an account whose documents do not contain the topic and verifying that
the assistant returns the safe refusal response.

**Acceptance Scenarios**:

1. **Given** an account whose documents do not cover a topic, **When** the user
   asks about that topic, **Then** the assistant returns the document-not-found
   refusal instead of a generic answer.
2. **Given** retrieval returns fewer than the required grounded contexts at the
   configured similarity threshold, **When** the user asks a question, **Then**
   the system does not lower the threshold and does not generate an answer from
   unrelated content.

---

### User Story 2 - Preserve Answerability For Grounded Questions (Priority: P2)

As a user asking about content that does exist in my documents, I want the
system to keep finding relevant supporting material without weakening the
grounding rules, so stricter relevance standards do not unnecessarily suppress
valid answers.

**Why this priority**: The grounding safeguard only works if document-backed
questions still remain answerable under normal usage.

**Independent Test**: Can be fully tested by asking a question whose answer is
present in the uploaded corpus and verifying that the assistant still returns a
grounded answer after the stricter threshold behavior is introduced.

**Acceptance Scenarios**:

1. **Given** an account using default retrieval settings and a question covered
   by uploaded documents, **When** the user asks the question, **Then** the
   system still finds enough relevant context to return a grounded answer.
2. **Given** a question with multiple relevant passages, **When** the user asks
   it, **Then** the system may consider a broader candidate pool before final
   selection without lowering the similarity floor.

---

### User Story 3 - Keep Account Settings Predictable (Priority: P3)

As an operator managing retrieval settings, I want stricter grounding behavior
to respect existing account-specific settings, so the rollout does not silently
rewrite saved configuration.

**Why this priority**: Configuration predictability reduces rollout risk and
avoids accidental tenant-by-tenant behavior changes beyond the approved scope.

**Independent Test**: Can be fully tested by comparing default-setting accounts
with accounts that already have stored retrieval settings and verifying that
existing overrides continue to be honored.

**Acceptance Scenarios**:

1. **Given** an account with stored retrieval settings, **When** the feature is
   deployed, **Then** the account keeps its saved settings until explicitly
   changed.
2. **Given** an account that relies on default retrieval settings, **When** a
   retrieval settings record is first created, **Then** it uses the new default
   candidate count and the existing threshold as its minimum relevance floor.

### Edge Cases

- What happens when no chunk meets the configured threshold even after query
  rewrite and reranking are enabled?
- How does the system behave when an account has no stored retrieval settings
  record and defaults must be created on first use?
- What happens when a question retrieves only loosely related chunks that would
  previously have been admitted by threshold fallback?
- How does the system behave when a saved account configuration uses a lower
  or higher candidate count than the new default?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in
  React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before
  implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example`
  MUST be updated.
- Customer data MUST be protected with least-privilege access and secure
  transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration,
  domain logic, and persistence.
- Specs MUST identify files or modules that should remain
  responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP routes remain transport-only, `ChatService` remains
  chat orchestration, retrieval eligibility rules remain in retrieval-domain
  services, and repositories remain persistence-only.
- **Encapsulation Rule**: The chat orchestration module MUST stay responsible
  for deciding whether to call the language model, but it MUST NOT absorb
  retrieval-threshold policy or vector-search fallback logic.
- **New Seams Required**: Any new grounding-decision helper introduced by this
  feature MUST live under retrieval services and expose a focused contract that
  can be unit tested without HTTP or database wiring.
- **Anti-Goals**: Do not implement this safeguard only through prompt wording.
  Do not add retrieval policy logic to route handlers. Do not silently rewrite
  existing account retrieval settings in storage as part of rollout.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST treat each account's configured similarity
  threshold as the minimum similarity allowed for retrieval candidates used to
  answer chat questions.
- **FR-002**: The system MUST NOT lower the similarity threshold below the
  configured account value when first-pass retrieval returns too few candidates.
- **FR-003**: The system MUST return the existing safe refusal response when no
  sufficiently grounded context is available at the configured threshold.
- **FR-004**: The system MUST allow default-setting accounts to consider a
  modestly larger first-pass candidate pool than before this feature, without
  weakening the similarity floor.
- **FR-005**: The system MUST preserve explicitly stored per-account retrieval
  settings unless an operator or user updates them through existing settings
  flows.
- **FR-006**: The system MUST include automated backend coverage for at least
  one out-of-corpus question that previously could have produced an unsupported
  answer and at least one in-corpus question that should still be answerable.
- **FR-007**: The system MUST keep the grounding decision auditable enough for
  engineers to distinguish safe refusals caused by insufficient grounded context
  from successful grounded answers during debugging.

### Key Entities *(include if feature involves data)*

- **Retrieval Settings**: Account-scoped chat retrieval configuration including
  the similarity floor and candidate count used for first-pass retrieval.
- **Retrieved Candidate**: A document chunk eligible for answering, with
  similarity and rerank relevance data that determine whether it is grounded
  enough to support an answer.
- **Chat Answer Outcome**: The final result of a question, either a grounded
  answer backed by retrieved context or a safe refusal when grounded context is
  insufficient.

## Assumptions

- Existing accounts that already have saved retrieval settings will keep those
  saved values after rollout.
- The increase to the default candidate count is intentionally modest and is
  meant to protect recall, not to broaden the product scope or introduce new
  tuning controls.
- The existing refusal text remains acceptable for this feature unless tests
  reveal that wording changes are needed to preserve current API behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In regression coverage for this feature, out-of-corpus questions
  consistently return the safe refusal response instead of a generic answer.
- **SC-002**: In regression coverage for this feature, document-backed
  questions remain answerable when relevant material exists at or above the
  configured threshold.
- **SC-003**: Existing accounts with saved retrieval settings retain their
  stored configuration after the feature is released.
- **SC-004**: Engineering investigation of a chat request can determine whether
  the system answered or refused based on grounded-context availability without
  requiring ad hoc code changes.
