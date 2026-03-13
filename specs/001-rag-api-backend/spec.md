# Feature Specification: Modular RAG Backend

**Feature Branch**: `001-rag-api-backend`  
**Created**: 2026-03-13  
**Status**: Draft  
**Input**: User description: "I need a scalable modular RAG system. The core backend should use node.js with typescript, postgres with vector support. Create a /backend folder and put the code there.

The initial version should support API calls:
1. Registration with email and password, yielding a user id and secure session
2. Getting the token for an account
3. Document ingestion with bearer token auth
4. Chat with streamed or non-streamed responses
5. Per-account settings for query rewrite, reranking, vector search top k, similarity threshold, and reranking top k

The document processing should be a classic RAG pipeline. The flow is: convert document to markdown, chunk it, embed it, run vector search, optionally rerank, then send the top results into the chat prompt. The graph is basically chat history -> query rewrite -> vector search -> memo property fetch -> rerank -> build prompt. The retrieval core is a straightforward pgvector similarity query in vectorSearch.ts, and chunking is generic Recursive Chunker. Chunks must have slight overlap.

Let the vector and chat models be in the .env file, and the OPENAI_API_KEY as well."

## Clarifications

### Session 2026-03-13

- Q: How should the secure session be delivered after registration/login? → A: Server-managed session via `HttpOnly` secure cookie.
- Q: How should chat history be handled in v1? → A: Server-stored conversations with conversation IDs.
- Q: Should v1 include a separate login endpoint for returning users? → A: Yes, add an email/password login endpoint that issues the same `HttpOnly` session cookie.
- Q: How many API tokens should each account have in v1? → A: One active token per account, with no rotation endpoint in v1.
- Q: How should new conversations be created in the chat API? → A: `POST /chat` starts a new conversation when `conversationId` is absent and returns the `conversationId` in the response.

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.
  
  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - Provision a Knowledge Account (Priority: P1)

An operator creates an account with an email address and password, receives a
new user identifier and secure signed-in session, and can later obtain the
account API token needed to call the ingestion and chat endpoints.

**Why this priority**: No retrieval workflow is usable until an account can be
created, authenticated, and issued credentials for API access.

**Independent Test**: Can be fully tested by registering a new account,
verifying a secure session is established, and requesting the account token for
subsequent API use.

**Acceptance Scenarios**:

1. **Given** a new email address and valid password, **When** the client submits
registration, **Then** the system creates a new account, returns a unique user
identifier, and establishes a secure `HttpOnly` session cookie.
2. **Given** an authenticated account session, **When** the client requests the
account token, **Then** the system returns the single active token associated
with that account and does not expose tokens from any other account.
3. **Given** an existing account with valid email and password, **When** the
client logs in, **Then** the system establishes a secure `HttpOnly` session
cookie for that same account.
4. **Given** invalid registration input, duplicate account data, or incorrect
login credentials, **When** the client submits registration, login, or token
retrieval, **Then** the system returns an appropriate client error response and
does not create or leak credentials.

---

### User Story 2 - Ingest Account Documents (Priority: P2)

An API client submits a text document for its account and receives a standard
HTTP creation or error response after the system normalizes the content, chunks
it with overlap, and prepares it for retrieval.

**Why this priority**: The system cannot answer account-specific questions until
it can transform submitted content into retrievable knowledge.

**Independent Test**: Can be fully tested by posting a document with a valid
bearer token and confirming the system stores retrievable document knowledge for
that same account.

**Acceptance Scenarios**:

1. **Given** a valid account token and well-formed document payload, **When**
the client posts to the document endpoint, **Then** the system returns `201`
and stores the document in a form that can be retrieved for later chat calls.
2. **Given** a missing or invalid bearer token, **When** the client posts a
document, **Then** the system rejects the request with an authorization error
and does not store the content.
3. **Given** malformed or empty document content, **When** the client posts a
document, **Then** the system returns a client error response and does not
create partial retrieval records.

---

### User Story 3 - Ask Retrieval-Grounded Questions (Priority: P3)

An API client sends a question for its account, either starting a new
server-stored conversation or continuing an existing one, and receives either a
regular JSON response or a streamed answer built from the account's retrieved
document chunks, using the account's retrieval settings to determine
rewriting, retrieval depth, thresholding, and reranking behavior.

**Why this priority**: This is the primary value of the RAG system, but it
depends on working account auth and document ingestion.

**Independent Test**: Can be fully tested by ingesting account content,
configuring retrieval settings, issuing chat requests with and without
streaming across multiple turns in the same conversation, and confirming that
only relevant account knowledge influences the response.

**Acceptance Scenarios**:

1. **Given** a valid account token and previously ingested content, **When**
the client sends a non-streaming chat request, **Then** the system returns an
HTTP success response containing an answer grounded in the retrieved document
content.
2. **Given** a valid account token and streaming enabled, **When** the client
submits a chat request, **Then** the system begins streaming answer output and
completes the response without exposing content from any other account.
3. **Given** a valid account token and no conversation reference, **When** the
client submits a chat request, **Then** the system starts a new conversation
and returns its conversation identifier in the response.
4. **Given** account retrieval settings with query rewrite or reranking
disabled, **When** the client submits a chat request, **Then** the system skips
those optional steps and still builds the answer from the remaining retrieval
pipeline stages.
5. **Given** an existing account conversation, **When** the client submits a
follow-up question for that same conversation, **Then** the system uses the
stored conversation history for retrieval preparation and answer generation.
6. **Given** retrieval settings are updated for an account, **When** the next
chat request is processed, **Then** the system applies the new settings to that
request without affecting other accounts.

---

### Edge Cases

- A chat request arrives for an account that has no ingested documents.
- A document is submitted with content too short to produce multiple chunks.
- Chunking overlap would otherwise create duplicate or zero-length chunks.
- Retrieval returns no chunks above the similarity threshold.
- The configured vector search `topK` or rerank `topK` is outside allowed
  bounds.
- Reranking is enabled but there are fewer retrieved chunks than the rerank
  limit.
- Streaming is requested but the model call fails after partial output has
  begun.
- Two accounts submit identical content; retrieval must remain account-scoped.
- An authenticated session exists but the account token is missing, revoked, or
  malformed.
- OpenAI credentials or model identifiers are missing from environment
  configuration at runtime.

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
- Chat model selection, embedding model selection, and `OPENAI_API_KEY` MUST be
  provided through environment configuration rather than hard-coded values.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Transport modules own HTTP request and response handling;
  application services own registration, token issuance, document ingestion,
  settings changes, and chat orchestration; domain modules own content
  normalization, chunking, retrieval flow decisions, and prompt assembly;
  persistence modules own account, session, token, document, chunk, and
  retrieval-setting storage plus vector similarity lookup.
- **Encapsulation Rule**: Route handlers remain transport-only; the retrieval
  module remains the only owner of similarity lookup behavior; the configuration
  module remains the only owner of direct environment-variable access; document
  ingestion and chat orchestration must not absorb persistence details.
- **New Seams Required**: A focused authentication service, session service,
  token service, document ingestion service, chunking service, embeddings
  service, vector search module, reranking service, retrieval settings service,
  and chat orchestration service; repository interfaces for account-scoped data
  access; a prompt-building module that accepts retrieved chunks and history as
  inputs only.
- **Anti-Goals**: Do not place retrieval ranking logic in route handlers; do
  not mix account auth session logic with long-lived API token handling; do not
  let chat orchestration write directly to vector storage; do not let a shared
  utility become the default home for retrieval decisions; do not allow
  cross-account retrieval or prompt construction; do not let route
  implementations become the only place where the API contract is defined.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow a client to register a new account by supplying
  an email address and password.
- **FR-002**: Successful registration MUST return a unique user identifier and
  establish a secure authenticated session for that account using a server-
  managed `HttpOnly` secure cookie.
- **FR-003**: System MUST reject invalid registration input and duplicate account
  registrations with appropriate HTTP client error responses.
- **FR-004**: System MUST allow an existing account to log in with email and
  password and establish a secure authenticated session using a server-managed
  `HttpOnly` secure cookie.
- **FR-005**: System MUST let an authenticated account obtain its bearer token
  for subsequent account API calls.
- **FR-006**: System MUST reject invalid login credentials with appropriate HTTP
  client error responses without revealing whether the email address exists.
- **FR-007**: System MUST maintain exactly one active bearer token per account
  in v1 and MUST NOT require token rotation or multi-token management in this
  release.
- **FR-008**: System MUST scope sessions, bearer tokens, documents, retrieval
  settings, and chat access to a single account and prevent access across
  accounts.
- **FR-009**: System MUST expose a document ingestion API that accepts a title
  and content payload for an authenticated account and returns standard HTTP
  status responses such as `201`, `400`, `401`, `403`, `404`, and `500` as
  appropriate.
- **FR-010**: During ingestion, system MUST normalize submitted content into a
  canonical markdown representation before chunking or embedding.
- **FR-011**: System MUST chunk canonical document content using a recursive
  chunking strategy with slight overlap between neighboring chunks.
- **FR-012**: System MUST create embeddings for each stored chunk and persist
  them for account-scoped retrieval.
- **FR-013**: System MUST allow an authenticated account to retrieve and update
  its per-account retrieval settings for query rewrite enablement, reranking
  enablement, vector search `topK`, similarity threshold, and rerank `topK`.
- **FR-014**: System MUST validate retrieval settings so vector search `topK`
  stays within `1` to `300`, similarity threshold stays within `0` to `1`, and
  rerank `topK` is a positive value that does not exceed retrieved result count
  at execution time.
- **FR-015**: System MUST expose a chat API that accepts a query and stream flag
  for an authenticated account and, when continuing an existing chat, a
  conversation reference, and returns either a complete answer response or a
  streamed answer with appropriate HTTP status handling.
- **FR-016**: When a chat request omits `conversationId`, system MUST create a
  new account-scoped conversation and return its conversation identifier in the
  response.
- **FR-017**: For each chat request, system MUST process retrieval in this
  order: stored conversation history, optional query rewrite, vector search,
  retrieval metadata fetch, optional rerank, and prompt construction.
- **FR-018**: Vector search MUST use account-scoped similarity retrieval against
  stored chunk embeddings and return the highest-ranked chunks that satisfy the
  configured similarity threshold.
- **FR-019**: If query rewrite is disabled for an account, system MUST skip that
  step and continue the remaining retrieval pipeline without failure.
- **FR-020**: If reranking is disabled for an account, system MUST skip rerank
  processing and use vector-search results directly when building the answer
  prompt.
- **FR-021**: If retrieval returns no usable chunks, system MUST return a safe,
  predictable answer that does not fabricate account knowledge as if it had been
  retrieved.
- **FR-022**: System MUST apply updated account retrieval settings on the next
  ingestion or chat request for that same account without requiring service
  restart.
- **FR-023**: System MUST keep chat model selection, embedding model selection,
  and OpenAI credentials in environment configuration and fail safely when those
  values are missing or invalid.
- **FR-024**: System MUST record sufficient operational events to support audit
  review of account creation, credential issuance, document ingestion, settings
  changes, and chat access failures without storing unnecessary sensitive data.
- **FR-025**: System MUST persist conversation history per account and reuse it
  for follow-up chat requests within the same conversation only.
- **FR-026**: System MUST record the shared HTTP API contract in an OpenAPI 3.1
  document stored under `/backend/openapi.yaml` so both humans and machines can
  use it as the reference for endpoints, authentication, payloads, status
  codes, and streaming behavior.
- **FR-027**: System MUST provide containerized local runtime artifacts under
  `/infra` that can start the backend service together with PostgreSQL +
  `pgvector`, expose the backend on port `8080`, and support health validation
  of the running API.

## Assumptions

- Initial release is backend-only and does not include a UI or admin console.
- “Secure session” refers to the authenticated login state established after
  registration and is delivered through a server-managed `HttpOnly` secure
  cookie; the bearer token used for ingestion and chat is a separate account
  credential.
- Each account has one active API bearer token in v1, and token rotation is out
  of scope for this release.
- The initial document API accepts direct text payloads rather than uploaded
  files, crawled pages, or third-party connectors.
- The “memo property fetch” step refers to retrieving document or chunk metadata
  needed to build the final prompt after vector search.
- Chat history is stored server-side per account rather than being fully
  resubmitted by the client on every request.
- A chat request without `conversationId` starts a new conversation and returns
  the new identifier in the response.
- Streaming behavior is delivered over a standard HTTP streaming response rather
  than through a separate websocket channel.
- The HTTP API contract is maintained as an OpenAPI 3.1 YAML document and
  serves as the shareable reference for engineering, testing, and generated
  tooling.
- The service is delivered under `/backend` and uses environment configuration
  for secrets and model identifiers.
- Containerized local execution is provided from `/infra` for repeatable
  backend and database startup during development and validation.

### Key Entities *(include if feature involves data)*

- **Account**: A tenant-scoped identity with an email address, password
  credential, user identifier, and account ownership of documents, settings,
  sessions, and bearer token.
- **Session**: A secure authenticated state tied to one account and used for
  login-bound operations such as token retrieval, delivered through a server-
  managed `HttpOnly` secure cookie.
- **Account Token**: A bearer credential issued to one account for authenticated
  document ingestion and chat API access; exactly one active token exists per
  account in v1.
- **Conversation**: An account-scoped stored chat thread containing ordered user
  and assistant messages and used as the source of prior history for follow-up
  requests.
- **Document**: Submitted account knowledge containing a title, canonical
  content representation, ownership metadata, and lifecycle status.
- **Chunk**: A retrievable segment derived from one document, including
  overlapping content boundaries, embedding vector, and provenance metadata.
- **Retrieval Settings**: Account-level controls governing query rewriting,
  reranking, retrieval depth, thresholding, and rerank depth.
- **Chat Request**: An account-scoped question with an optional conversation
  reference and a streaming preference.
- **Retrieved Context Set**: The ordered group of chunks and metadata selected
  for prompt construction for a specific chat request.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new account can be registered and issued an authenticated
  session in under 5 seconds for at least 95% of valid requests under expected
  launch load.
- **SC-002**: A valid account can obtain its bearer token in a single request
  without manual operator intervention for at least 99% of successful
  authenticated attempts.
- **SC-003**: A submitted text document of up to 10,000 words is accepted,
  normalized, and made available for retrieval within 15 seconds for at least
  95% of valid ingestion requests under expected launch load.
- **SC-004**: For accounts with relevant ingested content, at least 90% of
  evaluation questions whose answers are explicitly present in those documents
  return responses judged grounded in account content.
- **SC-005**: A non-streaming chat request returns a completed answer within 10
  seconds for at least 95% of valid requests under expected launch load.
- **SC-006**: A streaming chat request begins delivering output within 3 seconds
  for at least 95% of valid requests under expected launch load.
- **SC-007**: Changes to account retrieval settings take effect by the next
  eligible request for at least 99% of successful settings updates.
- **SC-008**: No acceptance test demonstrates retrieval leakage of one account’s
  documents into another account’s chat responses.
