# Feature Specification: Remote MCP Context Server

**Feature Branch**: `borohhov/mcp-control-plane`
**Created**: 2026-04-19  
**Updated**: 2026-04-22
**Status**: Approved  
**Input**: User description: "Let's do the next 2 weeks. This needs to be a fully functional remote MCP server with code that can be extracted to a separate repo soon, not Radioso addendum. For now, let it be a monorepo with all its benefits."

## Scope Review

**plan-ceo-review mode**: Selective expansion approved.

The prior stdio-only MCP package is not enough for the product direction. This feature now covers the first remote-hosted MCP wedge:

- package-owned remote Streamable HTTP transport
- package-owned credential exchange and short-lived MCP access tokens
- capability policies that expose only allowed tools
- explicit approval grants for write paths
- structured audit logging for auth and tool execution
- monorepo-local code that is organized for near-term extraction to its own repository

This expansion deliberately does **not** include a full multi-tenant hosted control plane, distributed token/session storage, or customer-facing UI workflows. Those are follow-on layers, not part of this implementation.

The current criticism-response expansion keeps the same package boundary but upgrades the product surface in three concrete ways:

- shared-store support so the runtime is not single-node by design
- workspace-aware policy resolution instead of runtime-global allowlists only
- explicit upstream capability and version negotiation instead of inferring support from 404s alone

This expansion still deliberately does **not** include a full OAuth identity product, customer-facing operator UI, or a complete hosted SaaS control plane. Those remain later layers.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect A Remote MCP Client To Workspace Knowledge (Priority: P1)

An operator runs the Radioso MCP server as an HTTP service, exchanges a Radioso workspace API token for a short-lived MCP access token, and uses a remote MCP client to search documents, inspect documents, and ask grounded questions with citations for that workspace.

**Why this priority**: Remote access is the product wedge. Without a real hosted transport and package-owned auth flow, the server remains a local utility instead of a distributable context surface.

**Independent Test**: Start the remote MCP server against a local Radioso stack, exchange a workspace API token for an MCP access token, call the remote MCP endpoint with read tools, and confirm the results remain workspace-scoped and grounded.

**Acceptance Scenarios**:

1. **Given** a Radioso workspace has indexed documents and a valid workspace API token, **When** an operator exchanges that token for an MCP access token and calls `search_documents`, **Then** the result includes only documents visible to that workspace.
2. **Given** a workspace contains grounded source material, **When** a remote MCP client calls `answer_grounded`, **Then** the result includes the same citation and answer-support behavior expected from Radioso's existing grounded answer path.
3. **Given** the client authenticates successfully, **When** it asks for capability discovery, document listing, or retrieval settings, **Then** it receives only the tools and data allowed for that issued MCP access token.

---

### User Story 2 - Govern Remote Write Operations With Policy And Approval (Priority: P1)

An operator or automation agent uses the same remote MCP server to create or update documents and workspace settings, but only if the server policy allows the tool and the caller has a valid approval grant for write-capable tools.

**Why this priority**: The user explicitly wants both read and write paths, but remote write access without policy and approval is product debt, not product progress.

**Independent Test**: Exchange credentials for a session, request an approval grant, perform allowed write tool calls, and verify the corresponding Radioso resources change only when both capability policy and approval requirements are satisfied.

**Acceptance Scenarios**:

1. **Given** a caller has a valid MCP access token but no write approval, **When** it calls `create_document`, **Then** the server denies the action with a structured approval-required error.
2. **Given** a caller has a valid MCP access token and a valid approval grant for document writes, **When** it calls `create_document` or `update_document`, **Then** the document changes are applied through existing Radioso APIs and reflected in later reads.
3. **Given** the server policy disallows a write tool for the current session, **When** the caller tries that tool even with an approval grant, **Then** the server denies the action with a structured capability-forbidden error.

---

### User Story 3 - Run The MCP Server Across Multiple Instances (Priority: P1)

An operator can run more than one MCP server instance behind the same deployment and have exchanged access sessions and approval grants work predictably across those instances without relying on process-local memory or sticky routing.

**Why this priority**: The strongest criticism is correct: a remote MCP server that only works as a single process is still a developer utility, not the beginning of a hosted product surface.

**Independent Test**: Start two MCP server instances backed by the same external session and approval store, exchange credentials through one instance, and complete a governed write flow through the other instance.

**Acceptance Scenarios**:

1. **Given** two MCP server instances share the same configured external store, **When** an access token is issued by one instance, **Then** the other instance can validate that token for read tool calls.
2. **Given** a write approval grant is issued by one instance, **When** a governed write tool is called through another instance before expiry, **Then** the request succeeds without requiring the same process-local runtime.
3. **Given** the remote package is running in local development mode, **When** no external store is configured, **Then** the server still supports a documented in-memory single-node mode for local smoke testing.

---

### User Story 4 - Adapt To Workspace Policy And Upstream Capability Drift (Priority: P1)

An operator can point the MCP server at different Radioso workspaces and different Radioso deployment versions, and the exposed MCP surface adapts cleanly to each workspace policy and each backend's supported capabilities instead of exposing tools that will fail later.

**Why this priority**: More MCP tools do not create product depth. Better policy and capability negotiation do, because they make the server trustworthy in real mixed-version and multi-workspace environments.

**Independent Test**: Exchange against workspaces with different configured policy profiles and against backend fixtures with different capability sets, then confirm `tools/list`, `describe_capabilities`, and tool execution align to the intersected support matrix.

**Acceptance Scenarios**:

1. **Given** the MCP package has a workspace-specific policy override, **When** a token for that workspace is exchanged, **Then** the granted tool set reflects the workspace override instead of only the global defaults.
2. **Given** an upstream Radioso deployment reports that some MCP-relevant capabilities are unavailable, **When** a session is exchanged, **Then** unsupported tools are excluded or marked unavailable before clients try to execute them.
3. **Given** a client asks `describe_capabilities`, **When** the session is active, **Then** the response includes the session-granted tools together with the upstream capability/version context that explains why unavailable tools are absent.

---

### User Story 5 - Fail Safely And Leave Audit Evidence (Priority: P2)

An operator receives clear failures and structured audit evidence when auth exchange fails, an MCP access token expires, a write approval expires, a capability is unsupported, or a caller tries to act outside workspace scope.

**Why this priority**: Remote protocol surfaces widen risk. Safe failure behavior and operator-auditable evidence are part of the core product, not optional polish.

**Independent Test**: Exercise bad-token, expired-token, approval-missing, approval-expired, unsupported-capability, malformed-input, and cross-workspace identifier scenarios and confirm the server returns structured failures while emitting audit events without leaking secrets.

**Acceptance Scenarios**:

1. **Given** a caller presents an invalid or expired MCP access token, **When** it calls `/mcp`, **Then** the server rejects the request without revealing the upstream Radioso token or workspace internals.
2. **Given** a caller presents a valid session but no valid approval grant for a governed write tool, **When** it calls that tool, **Then** the server returns a structured approval error and logs the denial.
3. **Given** an upstream Radioso deployment lacks a required capability, **When** a client calls the corresponding tool, **Then** the server returns a structured unsupported-capability error and records the event in audit logs.

### Edge Cases

- What happens when the upstream Radioso API token is revoked after the MCP access token was already issued?
- What happens when the MCP access token remains valid but the write approval grant expires between `tools/list` and `tools/call`?
- What happens when a client retries the same write request after a disconnect and the approval grant is single-use?
- What happens when an older Radioso deployment does not expose a capability required by a tool included in the current package build?
- What happens when a caller requests more capabilities during auth exchange than the server's configured policy allows?
- What happens when two MCP server instances race to consume the same single-use approval grant?
- What happens when the MCP server starts with Redis configured but the store is unavailable at boot or drops during requests?
- What happens when a workspace-specific policy file allows a tool that the upstream Radioso deployment does not support?
- What happens when the remote transport receives malformed JSON-RPC or unsupported HTTP methods?
- What happens when a document is still processing and the client requests grounded answers immediately afterward?
- What happens when audit logging fails while the tool execution succeeds?

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

- **Boundary Rule**: The MCP package owns remote HTTP transport, MCP protocol handling, credential exchange, MCP access token/session management, write approvals, capability policy enforcement, workspace-policy resolution, external store adapters for package-owned runtime state, and audit logging. The existing Radioso backend continues to own document lifecycle, grounded answer generation, retrieval, workspace settings, authorization of upstream workspace tokens, and persistence. The only allowed integration boundary is the stable Radioso HTTP contract plus a lightweight backend-owned capability/context endpoint consumed through a focused package-local client adapter.
- **Encapsulation Rule**: `backend/src/app/http/routes/*`, existing backend service modules, and existing auth/persistence code MUST NOT import MCP protocol packages or package-owned auth/session modules. The MCP package MUST NOT import backend domain modules directly. Any new backend route added for token introspection or capability context MUST remain thin and MUST NOT absorb MCP policy, approval, or transport logic.
- **New Seams Required**: Introduce package-local external-store adapters, package-local workspace policy profile resolution, package-local upstream capability negotiation, and a backend-owned HTTP endpoint that returns workspace identity plus MCP-relevant capability/version metadata for the authenticated workspace token.
- **Anti-Goals**: Do not bolt MCP handlers into the backend route tree. Do not pass raw Radioso workspace API tokens through MCP tool calls. Do not make backend modules depend on MCP runtime libraries. Do not bypass existing Radioso auth, validation, or grounded-answer paths with direct database access from the MCP package. Do not rely on sticky-session-only deployment as the only supported multi-instance strategy. Do not implement a full hosted SaaS control plane or customer-facing OAuth UI in this feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a remote Radioso MCP server that can run as a separate HTTP process or package from the main backend HTTP server.
- **FR-002**: The remote MCP server MUST expose an MCP-compatible HTTP endpoint for remote clients using Streamable HTTP semantics, with a documented curl-based smoke flow.
- **FR-003**: The remote MCP server MUST expose a package-owned auth exchange endpoint that accepts a supported Radioso workspace credential and returns a short-lived MCP access token without returning the upstream Radioso token to the client.
- **FR-004**: The MCP access token MUST be validated by package-owned auth/session code before any tool execution occurs.
- **FR-005**: The server MUST support a read connection path for workspace-scoped context access using the issued MCP access token.
- **FR-006**: The server MUST support write-capable tools for allowed workspace content and settings operations using the issued MCP access token plus a valid approval grant when policy requires approval.
- **FR-007**: The first release MUST expose at least one grounded-answer read tool, at least one document-search read tool, and at least one document-write tool through the remote endpoint.
- **FR-008**: Read tools MUST return only data visible to the authenticated workspace scope and MUST NOT reveal cross-workspace resource existence.
- **FR-009**: Write tools MUST execute through Radioso's existing validation and authorization boundaries rather than direct database writes from the MCP package.
- **FR-010**: The grounded-answer MCP tool MUST preserve the same grounding, citation, and answer-support behavior as the existing covered Radioso answer path for the target workspace.
- **FR-011**: The server MUST support package-owned capability policies that can disable tools globally and/or per exchanged session.
- **FR-012**: The server MUST provide a capability discovery path so clients can distinguish allowed tools from denied or unavailable tools without trial-and-error writes.
- **FR-013**: The server MUST support explicit approval grants for governed write tools, including approval expiry and clear approval-required failures.
- **FR-014**: The server MUST emit structured audit events for auth exchange, approval issuance, tool allow/deny decisions, tool execution outcomes, and upstream capability mismatches.
- **FR-015**: Audit events MUST exclude raw Radioso workspace API tokens and other secrets from structured output.
- **FR-016**: The server MUST communicate with Radioso through a stable code boundary that can be versioned and tested independently from MCP transport concerns.
- **FR-017**: Code-level dependencies MUST remain one-way from the MCP package toward Radioso client contracts and MUST NOT require the Radioso backend to depend on MCP package code.
- **FR-018**: The implementation MUST keep package-owned server concerns in directories/modules that can be extracted to a separate repository without backend refactors.
- **FR-019**: The server MUST provide a clear startup and configuration flow for base URL, remote bind address/port, signing secret, token TTLs, policy configuration, and any required capability flags without committing secrets to the repo.
- **FR-020**: The feature MUST include automated package-level coverage that proves auth exchange, policy gating, approval enforcement, audit logging, and read/write MCP tools use the intended Radioso contract boundaries and preserve workspace isolation.
- **FR-021**: Public API or SDK changes required to support the MCP server MUST be documented and kept in sync with generated contract artifacts.
- **FR-022**: The server MUST degrade predictably when pointed at a Radioso deployment that lacks a required capability, including a clear unsupported-version or unsupported-feature error path.
- **FR-023**: If the server surfaces assistant-generated explanatory text to end users, that runtime conversational text MUST continue to come from the LLM rather than newly hard-coded application strings.
- **FR-024**: The MCP package MUST keep auth/session and approval state behind interfaces so runtime storage backends can be swapped without rewriting transport or tool modules.
- **FR-025**: The remote MCP server MUST support an external shared-store mode for MCP access sessions and approval grants so more than one server instance can serve the same exchanged session.
- **FR-026**: The remote MCP server MUST keep a documented in-memory store mode for local development and single-node smoke validation.
- **FR-027**: The backend MUST expose a lightweight authenticated context endpoint for workspace API tokens that returns workspace identity plus MCP-relevant capability and version metadata.
- **FR-028**: The MCP package MUST resolve the final granted tool set as the intersection of global runtime policy, workspace-specific policy overrides when configured, and upstream capability support returned by the backend context endpoint.
- **FR-029**: The MCP package MUST support workspace-specific policy overrides keyed by stable workspace identity and documented as operator configuration rather than code edits.
- **FR-030**: The remote MCP request path MUST NOT require process-local session-only transport state to validate exchanged sessions and approvals when the shared-store mode is enabled.
- **FR-031**: `describe_capabilities` and related capability discovery responses MUST communicate the active workspace policy and upstream capability context that determined the exposed tool set.
- **FR-032**: The feature MUST include automated coverage for multi-instance shared-store validation, workspace-specific policy resolution, and upstream capability negotiation in addition to existing remote read/write coverage.

### Key Entities *(include if feature involves data)*

- **MCP Remote Runtime**: The standalone Radioso-owned HTTP process that speaks MCP over Streamable HTTP and translates client tool calls into supported Radioso API operations.
- **MCP Access Session**: A package-owned authenticated session that binds one issued MCP access token to one upstream Radioso workspace token, a capability subset, an expiry, and audit metadata.
- **Approval Grant**: A package-owned short-lived permission artifact that authorizes one or more governed write tool calls for a specific access session.
- **Capability Policy**: A package-owned rule set that determines which tools can be exposed or executed for the current runtime and exchanged session.
- **MCP Tool Capability**: A named read or write operation exposed by the server, including its access mode, approval requirement, supported inputs, outputs, and required Radioso permissions.
- **Radioso API Adapter**: The focused client boundary used by the MCP package to call Radioso HTTP operations without importing backend domain modules directly.
- **Audit Event**: A structured record emitted by the MCP package for auth, policy, approval, execution, denial, and upstream capability outcomes.
- **Workspace MCP Context**: A backend-owned authenticated payload for a workspace API token that includes stable workspace identity plus MCP-relevant capability and version metadata.
- **Workspace Policy Profile**: A package-owned operator configuration record that overrides the runtime-global MCP policy for one or more specific workspaces.
- **Shared Runtime Store**: A package-owned storage backend used for MCP access sessions and approval grants across server instances.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, an engineer can start the remote MCP server against a Radioso deployment, exchange credentials, and complete first authenticated read access in under 15 minutes using documented setup steps alone.
- **SC-002**: In validation, covered MCP read tools return only workspace-scoped data for 100% of exercised scenarios.
- **SC-003**: In validation, governed MCP write tools succeed only when both capability policy and approval requirements are satisfied.
- **SC-004**: In validation, denied or expired approval paths fail with structured non-crashing responses and corresponding audit events.
- **SC-005**: In validation, the main Radioso backend build and runtime do not require MCP package imports or package-owned auth/session code to succeed.
- **SC-006**: In validation, a supported remote MCP client or documented JSON-RPC curl flow can complete at least one end-to-end read flow and one end-to-end write flow against the same workspace without opening the Radioso web app.
- **SC-007**: In validation, unsupported-version, bad-auth, malformed-input, approval-missing, approval-expired, and cross-workspace-access scenarios all fail safely with structured responses.
- **SC-008**: In validation, the MCP package's server-owned code can be identified as package-local modules with no direct imports from backend domain code.
- **SC-009**: In validation, two MCP server instances backed by the same configured shared store can exchange on one instance and complete a governed write on the other instance without reissuing credentials.
- **SC-010**: In validation, a workspace-specific policy override can narrow the tool catalog for one workspace without affecting another workspace on the same deployment.
- **SC-011**: In validation, the remote MCP server excludes or clearly marks unsupported tools before execution when pointed at an older or capability-limited Radioso deployment.

## Assumptions

- The current "next 2 weeks" scope should still prioritize boilable hosted-control-plane foundations over a larger customer-facing identity or admin UI program.
- A package-owned token exchange flow remains sufficient for this milestone even if full OAuth discovery and hosted multi-tenant identity are deferred.
- A shared external store plus stateless request handling are enough to make the runtime hostable for this milestone even if full multi-region control-plane work is deferred.
- Existing Radioso workspace API tokens are sufficient upstream credentials for validating exchange requests and executing allowed read/write operations.
- Existing Radioso read/write API routes remain sufficient for the MCP tool catalog, but one additive backend context route is acceptable because it strengthens the stable package/backend contract instead of weakening boundaries.
