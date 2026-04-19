# Feature Specification: MCP Context Server

**Feature Branch**: `043-mcp-context-server`  
**Created**: 2026-04-19  
**Status**: Approved  
**Input**: User description: "Add a standalone Radioso MCP server with both read and write paths for workspace-scoped context access, designed to minimize code-level mutual dependencies with the existing app."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect Any MCP Client To Workspace Knowledge (Priority: P1)

An operator points an MCP-capable client at a Radioso MCP server, provides Radioso credentials for one workspace, and can immediately search documents, inspect document details, and ask grounded questions with citations from that workspace.

**Why this priority**: This is the core distribution value. If agents cannot reliably read grounded workspace context through MCP, the feature does not meaningfully expand Radioso's reach.

**Independent Test**: Can be fully tested by starting the MCP server against a local Radioso instance, connecting a supported MCP client, authenticating to one workspace, calling read tools, and confirming the returned content matches the workspace data and stays scoped to that workspace.

**Acceptance Scenarios**:

1. **Given** a Radioso workspace has indexed documents and valid workspace credentials, **When** an MCP client calls the document-search tool, **Then** the client receives only results from that workspace with enough metadata to identify the matched documents.
2. **Given** a workspace contains grounded source material, **When** an MCP client calls the grounded-answer tool, **Then** the client receives an answer that includes the same citation and support behavior expected from Radioso's existing grounded chat path.
3. **Given** the client requests workspace settings or retrieval trace details, **When** the corresponding MCP read tool is called, **Then** the client receives operator-usable diagnostic data without exposing secrets or unrelated workspaces.

---

### User Story 2 - Let Agents Maintain Workspace Content Through MCP (Priority: P1)

An operator or automation agent uses the same MCP server to create documents, update documents, delete or reprocess documents, and tune supported workspace settings without opening the Radioso web app.

**Why this priority**: The user explicitly wants both read and write paths. Without write capabilities, the MCP server is only a thin read-only viewer and misses an important operator automation wedge.

**Independent Test**: Can be fully tested by connecting an MCP client with valid credentials, creating a document, updating it, triggering a supported operational write such as reprocess or settings change, and confirming the changes are reflected through Radioso's existing APIs and UI.

**Acceptance Scenarios**:

1. **Given** a client is authenticated for a workspace, **When** it calls the document-create tool with supported content and metadata, **Then** the document is created for that workspace and becomes visible through the existing Radioso document surfaces.
2. **Given** a client has an existing workspace document, **When** it calls the document-update or document-delete tool, **Then** the change applies only to that targeted workspace document and returns a clear success or failure result.
3. **Given** a client calls an allowed settings-write tool, **When** the update succeeds, **Then** the new setting is reflected in subsequent Radioso API reads and later grounded interactions.

---

### User Story 3 - Run The MCP Server As A Separate Product Surface (Priority: P1)

An engineer can run the MCP server as its own process or package, point it at a Radioso deployment, and upgrade either side without creating tight code-level coupling between the core product and the MCP transport layer.

**Why this priority**: This is the main architectural constraint for the feature. The value is not just adding MCP support, but doing it in a way that keeps Radioso's internal app code from becoming entangled with protocol-specific concerns.

**Independent Test**: Can be fully tested by building and starting the MCP server from its own package or entrypoint, confirming it communicates with Radioso through a stable HTTP or SDK boundary, and verifying the existing backend can build and run without importing MCP modules.

**Acceptance Scenarios**:

1. **Given** the MCP server package is installed with a Radioso base URL and credentials, **When** it starts, **Then** it can serve MCP tools without requiring the main backend HTTP process to import MCP transport code.
2. **Given** the Radioso backend codebase changes internally but preserves the supported HTTP contract, **When** the MCP server is rebuilt, **Then** it continues to operate through the stable contract boundary rather than by reaching into backend module internals.
3. **Given** the MCP server package is absent or disabled, **When** the Radioso backend starts, **Then** the backend still runs its existing application flows without depending on MCP runtime modules.

---

### User Story 4 - Fail Safely For Invalid Auth, Scope, Or Tool Use (Priority: P2)

An operator receives clear, safe failures when an MCP client uses invalid credentials, targets unsupported actions, or tries to act outside the allowed workspace scope.

**Why this priority**: MCP broadens the automation surface area. Clear and least-privilege failure behavior is part of the product, not an implementation afterthought.

**Independent Test**: Can be fully tested by attempting MCP calls with bad credentials, missing permissions, malformed payloads, and cross-workspace identifiers, then confirming the server denies the action safely and consistently.

**Acceptance Scenarios**:

1. **Given** a client uses invalid or expired credentials, **When** it calls any MCP tool, **Then** the server returns an authentication failure without leaking sensitive configuration details.
2. **Given** a client references a document or conversation outside the authenticated workspace, **When** it calls a read or write tool, **Then** the server refuses the action and does not reveal whether the foreign resource exists.
3. **Given** a client sends unsupported or malformed input to a tool, **When** the tool is called, **Then** the server returns a structured validation error instead of a crash or ambiguous partial success.

### Edge Cases

- What happens when a workspace token can perform document reads and writes but not admin-only operations the MCP client attempts?
- What happens when a write tool succeeds in Radioso but the client disconnects before receiving the final MCP response?
- What happens when a document is still processing and the client asks for grounded answers or citation-heavy reads immediately afterward?
- What happens when a client tries to send conversational copy or UI text overrides through write tools in a multilingual system that should keep runtime wording model-generated?
- What happens when the MCP server is newer than the connected Radioso deployment and a requested tool depends on an API capability that the target deployment does not expose yet?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Any public contract, operator workflow, or setup change introduced by the MCP server MUST update the corresponding documentation in the same delivery.
- If any backend runtime prompt asset is introduced or extracted for MCP-grounded answering behavior, that prompt asset MUST live under `backend/prompts/`.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The MCP server owns MCP transport, tool schemas, protocol authentication handling, and response shaping. The existing Radioso backend continues to own document lifecycle, grounded answer generation, retrieval, workspace settings, and persistence. The only allowed integration boundary between them is a stable HTTP contract and the first-party TypeScript SDK or another focused client adapter built on that contract.
- **Encapsulation Rule**: `backend/src/app/http/routes/*` and existing backend service modules MUST remain application-focused and MUST NOT import MCP protocol packages or tool definitions. The MCP server package MUST NOT import backend domain modules directly. The TypeScript SDK MUST remain a reusable client boundary rather than becoming an MCP-specific utility dump.
- **New Seams Required**: Introduce a standalone MCP server package or equivalent isolated runtime entrypoint, a focused Radioso API client adapter for MCP tool execution, and a tool-capability registry that maps supported read and write operations to existing Radioso contract calls without spreading protocol details into the main backend.
- **Anti-Goals**: Do not bolt MCP handlers directly into the existing backend route tree. Do not make backend modules depend on MCP transport libraries. Do not create bidirectional imports between the MCP server and the backend app. Do not bypass existing Radioso auth, validation, or grounded-answer paths with direct database access from the MCP server.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a Radioso MCP server that can run as a separate process or package from the main backend HTTP server.
- **FR-002**: The MCP server MUST support a read-only connection path for workspace-scoped context access using supported Radioso credentials.
- **FR-003**: The MCP server MUST support write-capable tools for allowed workspace content and settings operations using supported Radioso credentials.
- **FR-004**: The MCP server MUST expose at least one grounded-answer read tool, at least one document-search read tool, and at least one document-write tool in the first release.
- **FR-005**: Read tools MUST return only data visible to the authenticated workspace scope and MUST NOT reveal cross-workspace resource existence.
- **FR-006**: Write tools MUST execute through Radioso's existing validation and authorization boundaries rather than direct database writes from the MCP server process.
- **FR-007**: The grounded-answer MCP tool MUST preserve the same grounding, citation, and answer-support behavior as the existing covered Radioso answer path for the target workspace.
- **FR-008**: The MCP server MUST let operators list documents, inspect a single document, search documents, and retrieve grounded answers from a workspace through MCP.
- **FR-009**: The MCP server MUST let operators create documents, update documents, delete documents, and trigger at least one supported follow-up workspace operation such as document reprocessing or retrieval-settings updates through MCP.
- **FR-010**: The MCP server MUST fail safely with structured errors for invalid credentials, unsupported capabilities, malformed payloads, and unauthorized cross-workspace access attempts.
- **FR-011**: The MCP server MUST communicate with Radioso through a stable code boundary that can be versioned and tested independently from MCP transport concerns.
- **FR-012**: The implementation MUST keep code-level dependencies one-way from the MCP server toward Radioso client contracts and MUST NOT require the Radioso backend to depend on MCP server code.
- **FR-013**: The MCP server MUST provide a clear startup and configuration flow for base URL, credentials, and any required capability flags without committing secrets to the repo.
- **FR-014**: The feature MUST include automated backend and package-level coverage that proves read and write MCP tools use the intended Radioso contract boundaries and preserve workspace isolation.
- **FR-015**: Public API or SDK changes required to support the MCP server MUST be documented and kept in sync with generated contract artifacts.
- **FR-016**: If the MCP server surfaces assistant-generated explanatory text to end users, that runtime conversational text MUST continue to come from the LLM rather than newly hard-coded application strings.
- **FR-017**: The MCP server MUST support safe capability discovery so clients can distinguish available read tools from available write tools without trial-and-error failures.
- **FR-018**: The MCP server MUST degrade predictably when pointed at a Radioso deployment that lacks a required capability, including a clear unsupported-version or unsupported-feature error path.

### Key Entities *(include if feature involves data)*

- **MCP Server Runtime**: The standalone Radioso-owned process or package that speaks MCP and translates client tool calls into supported Radioso API operations.
- **Radioso MCP Client Session**: The authenticated session context that binds an MCP client connection to one Radioso workspace scope and a set of allowed capabilities.
- **MCP Tool Capability**: A named read or write operation exposed by the MCP server, including its supported inputs, outputs, and required Radioso permissions.
- **Radioso API Adapter**: The focused client boundary used by the MCP server to call Radioso HTTP or SDK operations without importing backend domain modules directly.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, an engineer can start the MCP server against a Radioso deployment and complete first authenticated read access in under 10 minutes using documented setup steps alone.
- **SC-002**: In validation, covered MCP read tools return only workspace-scoped data for 100% of exercised scenarios.
- **SC-003**: In validation, covered MCP write tools successfully create or mutate workspace resources through existing Radioso authorization and validation paths without direct database coupling.
- **SC-004**: In validation, the main Radioso backend build and runtime do not require MCP server packages or imports to succeed.
- **SC-005**: In validation, a supported MCP client can complete at least one end-to-end read flow and one end-to-end write flow against the same workspace without opening the Radioso web app.
- **SC-006**: In validation, unsupported-version, bad-auth, malformed-input, and cross-workspace-access scenarios all fail with structured non-crashing responses.

## Assumptions

- The first release should optimize for a small, high-value tool set rather than mirroring every existing Radioso operation over MCP.
- A separate package in the repo is an acceptable definition of "standalone" as long as the backend does not import it and the server communicates through stable client-facing contracts.
- Existing Radioso API tokens and session-backed admin flows are sufficient to support the initial MCP read and write tool set, with additive contract work only where a required capability is not already exposed cleanly.
- The MCP server should favor stable document and settings operations over higher-risk destructive account-administration capabilities in v1.
