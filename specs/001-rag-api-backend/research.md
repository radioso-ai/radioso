# Research: Modular RAG Backend

## Decision 1: Use OpenAPI 3.1 YAML as the shared API contract

- **Decision**: Record the HTTP API contract as OpenAPI 3.1 YAML, with the
  planning draft at
  `/Users/dm/code/radioso/specs/001-rag-api-backend/contracts/openapi.yaml` and
  the implementation artifact at `/Users/dm/code/radioso/backend/openapi.yaml`.
- **Rationale**: OpenAPI 3.1 is machine-readable, shareable with humans through
  rendered docs, compatible with JSON Schema, and suitable for contract tests,
  mock generation, and SDK generation.
- **Alternatives considered**:
  - Markdown-only endpoint documentation: easier to write but weak for code
    generation and automated validation
  - Ad hoc Postman collection: useful for requests but weaker as the canonical
    schema source

## Decision 2: Use opaque Postgres-backed sessions with `HttpOnly` cookies

- **Decision**: Implement auth sessions as opaque server-managed IDs stored in
  Postgres and delivered via `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
- **Rationale**: This satisfies the clarified session model, avoids exposing
  signed session payloads to clients, and fits a single-service Postgres-backed
  MVP without adding Redis.
- **Alternatives considered**:
  - JWT session tokens: simpler stateless verification, but weaker revocation
    and more client exposure
  - In-memory session store: simple locally, but not durable or horizontally
    safe

## Decision 3: Store one active API token per account

- **Decision**: Generate one active `sk_proj_*` bearer token per account and
  store only a hash of the token in Postgres.
- **Rationale**: Matches the clarified scope, reduces token-management surface
  area, and preserves the ability to verify tokens without storing them in
  plaintext.
- **Alternatives considered**:
  - Multiple tokens per account: more flexible, but adds inventory, labeling,
    and revoke semantics not needed in v1
  - Plaintext token storage: simpler lookup, but worse security posture

## Decision 4: Use Server-Sent Events for streamed chat

- **Decision**: Model streaming chat responses as `text/event-stream`.
- **Rationale**: SSE works over standard HTTP, is easier to expose in OpenAPI
  than websocket protocols, and fits incremental text output for a single
  request/response lifecycle.
- **Alternatives considered**:
  - WebSockets: more flexible but unnecessary for v1 request-scoped streaming
  - Chunked JSON over plain text: possible, but less standardized for clients

## Decision 5: Validate transport payloads with Zod

- **Decision**: Use Zod schemas at the HTTP boundary for request and response
  shape validation.
- **Rationale**: Zod works well with TypeScript, keeps runtime validation
  explicit, and aligns cleanly with generated OpenAPI component schemas.
- **Alternatives considered**:
  - Handwritten validation: lower dependency count, but repetitive and error
    prone
  - Class-validator style decorators: workable, but heavier and more coupled to
    class-based transport models

## Decision 6: Keep rewrite and rerank in dedicated retrieval services

- **Decision**: Query rewrite and rerank remain optional dedicated steps within
  the retrieval module and use the configured GPT-5.2 chat model rather than a
  separate rerank model setting in v1.
- **Rationale**: The spec only requires chat and vector model environment
  settings; reusing the chat model avoids widening the configuration surface for
  v1 while preserving the required optional pipeline steps.
- **Alternatives considered**:
  - Dedicated rerank model configuration: potentially more efficient, but adds
    another product choice not requested
  - Heuristic rerank only: simpler, but does not satisfy the expected optional
    rerank capability as strongly

## Decision 7: Use recursive chunking with modest overlap

- **Decision**: Use a recursive text splitter with overlap sized to preserve
  sentence continuity across boundaries, targeting approximately 10-15%
  overlap.
- **Rationale**: This matches the requested classic RAG pattern and balances
  retrieval quality against storage growth.
- **Alternatives considered**:
  - No overlap: cheaper storage, but weaker context preservation
  - Large overlap: better continuity, but more duplication and noisier retrieval

## Decision 8: Test from contract down to persistence

- **Decision**: Use failing contract tests and integration tests before module
  implementation, then add focused unit tests for chunking, vector filtering,
  prompt assembly, and token/session rules.
- **Rationale**: This satisfies the constitution’s backend TDD rule while
  keeping high-value behaviors covered first.
- **Alternatives considered**:
  - Unit-only TDD: faster locally, but weaker API and persistence confidence
  - Manual verification first: violates the constitution and increases rework
