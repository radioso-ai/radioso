# Feature Specification: Radioso TypeScript SDK

**Feature Branch**: `borohhov/typescript-sdk`  
**Created**: 2026-04-04  
**Status**: Draft  
**Input**: User description: "I need to start supporting typescript SDK"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Integrate Radioso with a Token (Priority: P1)

An external developer can install the Radioso SDK, configure a base URL and API token, and call the primary supported Radioso operations without writing raw HTTP requests.

**Why this priority**: Lowering the cost of first integration is the core value of the SDK. If developers still need to hand-build requests for the main token-compatible workflows, the SDK does not solve the adoption problem.

**Independent Test**: Can be fully tested by following the SDK quickstart to configure a token, initialize the client, and complete successful document, settings, workspace, and non-streaming chat operations against a Radioso environment.

**Acceptance Scenarios**:

1. **Given** a developer with a valid Radioso API token, **When** they follow the SDK quickstart, **Then** they can configure the client and complete a supported API call without building their own request wrapper.
2. **Given** a developer uses a supported SDK operation, **When** the request succeeds, **Then** they receive typed request and response data that matches the documented contract for that operation.
3. **Given** a developer sends an invalid request or uses an invalid token, **When** Radioso rejects the request, **Then** the SDK returns a consistent error shape that makes the failure actionable.

---

### User Story 2 - Consume Streaming Chat Without Parsing SSE (Priority: P2)

An external developer can use the SDK to consume Radioso streaming chat responses without implementing their own server-sent event parser.

**Why this priority**: Streaming chat is one of the easiest integration points to get wrong. If consumers must parse raw event streams themselves, the SDK leaves one of the highest-friction workflows unsolved.

**Independent Test**: Can be fully tested by starting a streamed chat request through the SDK and verifying that ordered stream events can be consumed directly by application code until completion or failure.

**Acceptance Scenarios**:

1. **Given** a developer starts a streaming chat request through the SDK, **When** Radioso emits incremental events, **Then** the SDK surfaces those events in order through a typed interface without exposing raw SSE parsing.
2. **Given** a streamed chat request completes successfully, **When** the final event is received, **Then** the SDK exposes the final answer payload and associated completion details in a form ready for application use.
3. **Given** the stream fails, is interrupted, or closes unexpectedly, **When** the SDK detects the problem, **Then** it reports the failure clearly and does not treat partial output as a successful completion.

---

### User Story 3 - Keep the SDK Aligned with the Backend Contract (Priority: P3)

A Radioso maintainer can refresh the SDK when the backend API contract changes and can detect drift before shipping a release.

**Why this priority**: A useful SDK requires a reliable maintenance workflow. If the package surface and documentation drift from the backend contract, the SDK quickly becomes misleading and expensive to trust.

**Independent Test**: Can be fully tested by updating the backend API contract, running the documented SDK sync workflow, and verifying that supported SDK operations and docs stay aligned with the contract source.

**Acceptance Scenarios**:

1. **Given** the documented Radioso backend contract changes for an in-scope operation, **When** a maintainer follows the SDK refresh workflow, **Then** they can update the SDK surface and documentation without rediscovering the API behavior manually.
2. **Given** the SDK or its examples no longer match the documented contract, **When** maintainers run the validation workflow, **Then** the mismatch is detected before release.

### Edge Cases

- How does the SDK behave when a developer tries to use a session-only or browser-only workflow through the initial token-focused SDK?
- How does the SDK report network timeouts, malformed JSON payloads, non-JSON error responses, or interrupted streaming connections?
- What happens when the backend contract changes in a backward-incompatible way between SDK releases?
- How does the SDK handle documented optional fields that are absent in live responses?
- What happens when a developer targets a Radioso deployment whose contract version is older than the SDK expects?

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
- Backend HTTP contract changes MUST use the code-first OpenAPI registry and treat generated OpenAPI files as artifacts rather than hand-authored sources.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The initial SDK delivery must keep contract-derived request and response shapes, core request transport, authentication configuration, streaming chat handling, and developer-facing documentation/examples in distinct ownership areas so contract refreshes do not require editing unrelated logic.
- **Encapsulation Rule**: `backend/src/app/http/openapi/document.ts` must remain the authoritative backend contract source, and the SDK must treat that contract as the source of truth rather than redefining endpoint semantics or embedding hidden product rules in convenience helpers.
- **New Seams Required**: The work must establish explicit seams for the generated API surface, the handwritten streaming adapter, contract refresh validation, and consumer documentation so each can evolve without collapsing into a single monolithic SDK entrypoint.
- **Anti-Goals**: Do not start by splitting the SDK into a separate repository. Do not claim support for undocumented or internal-only endpoints. Do not expand the first release into full parity with browser-session or admin-only workflows. Do not require consumers to read backend source code to understand SDK behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a Radioso SDK deliverable that can be versioned, documented, and validated as a product surface for external developers.
- **FR-002**: The first SDK release MUST support the Radioso operations that are both documented in the official backend contract and explicitly declared in scope for token-based external consumption.
- **FR-003**: The SDK MUST expose typed request inputs and typed response outputs for each supported operation.
- **FR-004**: The first SDK release MUST support configuration through developer-supplied base endpoint and API token values without requiring SDK source edits.
- **FR-005**: The first SDK release MUST define and document which categories of operations are supported, including the explicit exclusion of session-only or browser-only workflows from the initial scope.
- **FR-006**: The SDK MUST provide a consistent error model for failed requests, including validation failures, authentication failures, missing resources, and unexpected server errors.
- **FR-007**: The SDK MUST support both standard request-response chat calls and streaming chat calls for the documented in-scope chat interface.
- **FR-008**: The SDK MUST surface streaming chat events in a typed, consumable form that does not require application developers to parse raw event-stream payloads themselves.
- **FR-009**: The SDK MUST preserve documented optional fields and metadata fields in responses when they are present.
- **FR-010**: The SDK MUST include quickstart documentation showing how to install it, configure authentication, initialize a client, and perform the primary supported workflows.
- **FR-011**: The SDK MUST document the contract version or snapshot that each SDK release is aligned with.
- **FR-012**: The SDK MUST include a documented workflow for refreshing supported operations and examples when the backend contract changes.
- **FR-013**: The SDK MUST include validation steps that detect when supported request or response shapes, examples, or stream expectations diverge from the official backend contract.
- **FR-014**: The SDK documentation MUST explain how developers should choose between standard chat usage and streaming chat usage, including the outputs and failure modes they should expect from each mode.
- **FR-015**: The first SDK release MUST be maintainable within the main Radioso codebase until the contract-refresh workflow and package surface are proven stable enough to justify repository separation.

### Key Entities *(include if feature involves data)*

- **SDK Release Surface**: The documented set of supported operations, configuration expectations, examples, validation steps, and version metadata presented to SDK consumers.
- **Contract Snapshot**: The authoritative backend API description that the SDK release is aligned with and refreshed from.
- **Client Configuration**: The developer-supplied connection values needed to target a Radioso deployment, including base endpoint and API token.
- **Supported Operation**: A documented Radioso action exposed through the SDK, including its inputs, outputs, authentication expectations, and error behavior.
- **Streaming Chat Event**: A typed event emitted during streamed chat interactions, including ordered incremental output, completion, and failure signals.

## Assumptions

- The first SDK release will prioritize token-based external integration workflows over browser-session or admin-only workflows.
- The initial release will favor a high-quality core SDK, documentation, and contract refresh workflow over package publishing automation or marketplace integrations.
- Undocumented or internal-only endpoints remain out of scope until they are intentionally added to the official backend contract and accepted into the SDK support boundary.
- Repository separation is deferred until the package surface and contract-sync workflow have proven stable through repeated in-repo releases.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new developer can complete the SDK quickstart and perform a successful authenticated call against a supported Radioso operation in 15 minutes or less without writing custom request wrapper code.
- **SC-002**: The initial SDK release supports 100% of the documented operations that are explicitly declared in scope for the first token-based release.
- **SC-003**: Streaming chat consumers can receive ordered incremental output, completion, and failure events through the SDK without implementing their own event-stream parser.
- **SC-004**: Contract validation detects mismatches between the SDK surface and the official backend contract before a release candidate is accepted.
- **SC-005**: Maintainers can refresh the SDK against a changed in-scope backend contract without manually rediscovering supported request and response shapes.
