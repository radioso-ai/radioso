# Feature Specification: Hivec TypeScript SDK Repository

**Feature Branch**: `022-typescript-sdk-repo`  
**Created**: 2026-03-21  
**Status**: Draft  
**Input**: User description: "I want to create a separate repo for typescript SDK for radioso"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Integrate Hivec Quickly (Priority: P1)

An external developer can install the SDK from the dedicated repository, configure authentication, and call the documented Hivec API operations without writing raw HTTP request code.

**Why this priority**: The primary value of the new repository is to lower adoption cost for external integrators. If the SDK cannot replace manual request construction for the documented API, the separate repo does not solve the core problem.

**Independent Test**: Can be fully tested by following the repository quickstart to authenticate and successfully call workspace, document, settings, and chat operations against a Hivec environment.

**Acceptance Scenarios**:

1. **Given** a developer with valid Hivec credentials or token, **When** they follow the SDK quickstart, **Then** they can authenticate and complete a successful API call without implementing their own HTTP client wrapper.
2. **Given** a developer using the SDK for a documented operation, **When** the request succeeds, **Then** they receive typed response data that matches the documented contract.
3. **Given** a developer sends an invalid request through the SDK, **When** Hivec rejects the request, **Then** the SDK returns a consistent error shape that makes the failure actionable.

---

### User Story 2 - Consume Streaming Chat Safely (Priority: P2)

An external developer can use the SDK to consume Hivec chat streaming responses without implementing their own server-sent event parsing logic.

**Why this priority**: Streaming chat is a distinct part of Hivec’s developer experience and is easy to get wrong if every integrator must parse event streams manually.

**Independent Test**: Can be fully tested by starting a streamed chat request through the SDK and verifying that conversation, chunk, and completion events are emitted in order and can be consumed by application code.

**Acceptance Scenarios**:

1. **Given** a developer starts a streamed chat request, **When** Hivec emits incremental events, **Then** the SDK surfaces those events in a consumable typed form and preserves their order.
2. **Given** a streamed chat request completes, **When** the final event is received, **Then** the SDK exposes the final answer payload and retrieval details without requiring manual event decoding.
3. **Given** the stream fails or closes unexpectedly, **When** the SDK detects the interruption, **Then** it reports the failure clearly and does not silently return incomplete results as success.

---

### User Story 3 - Maintain Contract Alignment (Priority: P3)

A Hivec maintainer can update the separate SDK repository when the backend contract changes and can determine whether the SDK still matches the documented API.

**Why this priority**: A separate SDK repository only remains useful if maintainers can keep it aligned with the source contract and detect drift before it affects consumers.

**Independent Test**: Can be fully tested by updating the source API contract, running the repository’s documented sync workflow, and verifying that contract changes are reflected in the SDK surface and documentation.

**Acceptance Scenarios**:

1. **Given** the documented Hivec API contract changes, **When** a maintainer follows the sync workflow, **Then** the SDK repository can be updated without re-discovering the API surface manually.
2. **Given** the SDK no longer matches the documented contract, **When** maintainers run repository validation steps, **Then** the mismatch is detected before release.

### Edge Cases

- How does the SDK behave when a developer uses the wrong authentication mode for an operation that requires a different credential type?
- How does the SDK report network timeouts, malformed JSON responses, or interrupted streaming connections?
- What happens when the documented contract changes in a backward-incompatible way between SDK releases?
- How does the SDK handle documented optional fields that are absent in live responses?
- What happens when a developer targets a Hivec deployment running an older contract version than the SDK expects?

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

- **Boundary Rule**: The separate SDK repository must keep API transport, authentication configuration, generated or contract-derived models, streaming adapters, and developer-facing documentation in distinct ownership areas so contract updates do not require editing unrelated logic.
- **Encapsulation Rule**: The contract source must remain the authoritative description of request and response shapes; convenience helpers may improve usability but must not redefine endpoint semantics or embed hidden product rules.
- **New Seams Required**: The repository must establish explicit seams for core client requests, streaming chat consumption, contract synchronization, and documentation/examples so each can evolve without collapsing into a single monolithic client file.
- **Anti-Goals**: Do not expand the scope into undocumented or internal-only endpoints. Do not require consumers to read backend source code to understand SDK behavior. Do not mix contract-sync responsibilities into consumer quickstart guidance.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a dedicated TypeScript SDK repository for Hivec that can be worked on, versioned, and documented independently from the main Hivec application repository.
- **FR-002**: The SDK repository MUST cover the Hivec API operations that are currently documented in the official API contract at the time the repository is created.
- **FR-003**: The SDK MUST expose typed request inputs and typed response outputs for each supported documented operation.
- **FR-004**: The SDK MUST support the documented authentication patterns required by the covered operations, including token-based and session-based access where applicable.
- **FR-005**: The SDK MUST let developers configure the target Hivec environment without editing SDK source files.
- **FR-006**: The SDK MUST provide a consistent error model for failed requests, including validation failures, authentication failures, missing resources, and unexpected server errors.
- **FR-007**: The SDK MUST support both standard request-response chat calls and streaming chat calls for the documented chat interface.
- **FR-008**: The SDK MUST surface streaming chat events in a typed, consumable form that does not require application developers to parse raw event-stream payloads themselves.
- **FR-009**: The SDK repository MUST include quickstart documentation showing how to install the SDK, configure authentication, initialize a client, and perform the primary documented workflows.
- **FR-010**: The SDK repository MUST document which Hivec API contract version or snapshot the SDK release is based on.
- **FR-011**: The SDK repository MUST include a documented workflow for syncing the SDK with changes to the official Hivec API contract.
- **FR-012**: The SDK repository MUST include validation steps that detect when the SDK’s supported shapes or examples diverge from the official contract.
- **FR-013**: The SDK repository MUST define support boundaries for the initial release, explicitly stating what is included, what is excluded, and how undocumented endpoints are handled.
- **FR-014**: The SDK MUST preserve documented optional data and metadata fields in responses rather than dropping them when they are present.
- **FR-015**: The SDK documentation MUST explain how developers can distinguish between request-response chat usage and streaming chat usage, including what outputs to expect from each mode.

### Key Entities *(include if feature involves data)*

- **SDK Repository**: The standalone developer-facing package source, documentation, examples, validation steps, and release metadata for the Hivec TypeScript SDK.
- **Contract Snapshot**: The versioned source of truth describing the Hivec API surface that the SDK release is aligned with.
- **Client Configuration**: The set of developer-supplied values needed to connect to a Hivec deployment, including base endpoint and authentication details.
- **Supported Operation**: A documented Hivec action exposed through the SDK, including its inputs, outputs, authentication expectations, and error behavior.
- **Streaming Chat Event**: A typed event emitted during streamed chat interactions, including conversation start, incremental content, and completion or failure signals.

## Assumptions

- The first SDK release will target the API surface already documented in Hivec’s current official API contract.
- The initial release will prioritize a high-quality core SDK and documentation over release automation or marketplace integrations.
- Undocumented or internal-only endpoints are out of scope until they are added to the official contract and intentionally accepted into the SDK.
- The separate repository may be developed before public package publishing is finalized, as long as the repository is structured for external consumption.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new developer can complete the documented SDK quickstart and perform a successful authenticated Hivec API call in 15 minutes or less without writing custom request wrapper code.
- **SC-002**: The initial SDK release supports 100% of the operations present in the official API contract that are explicitly declared in scope for the first release.
- **SC-003**: Streaming chat consumers can receive ordered conversation, incremental content, and completion results through the SDK without implementing their own event-stream parser.
- **SC-004**: Contract validation detects mismatches between the SDK and the official API contract before a release candidate is accepted.
- **SC-005**: The repository documentation enables developers to complete the primary integration flows with at least an 85% first-attempt completion rate in internal validation or guided trial runs.
