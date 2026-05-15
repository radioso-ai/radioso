# Feature Specification: MCP Server Deployment Modes

**Feature Branch**: `mcp-deployment-modes`
**Created**: 2026-05-15
**Status**: Approved
**Input**: User description: "Allow the MCP server to be mounted onto the main Radioso backend so a single host can serve `radioso.example.com/mcp`, while keeping the standalone deployment available for SaaS / hardened public-host setups."

## Background

Today, `packages/radioso-mcp-server` ships as a standalone HTTP service on its own port (default `8787`) with its own auth surface: clients obtain a short-lived access token via `POST /v1/auth/exchange` by trading a Radioso workspace API token, then connect to `{mcp-host}/mcp` with `Authorization: Bearer mcp_sess_…` (TTL 15 min by default).

This split has real benefits — independent scaling, separate network policy (public MCP behind hardened auth while the backend stays internal), and a clean token-exchange seam — but it imposes setup friction for self-hosted operators whose backend and MCP endpoint live on the same trusted network. They pay the cost of two processes, two URLs, and an exchange dance that complicates the "Connect your client" story we just shipped in the MCP channel card.

The MCP spec (Streamable HTTP transport) does not require a dedicated server: it only requires a JSON-RPC POST endpoint with session-header semantics. Reference implementations and community servers routinely mount onto existing apps. Radioso should offer the same flexibility.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Self-Hosted Operator: Single-Host Deployment (Priority: P1)

A self-hosted Radioso operator running a single backend instance can serve MCP from the same host (`radioso.example.com/mcp`) using the existing workspace API token directly, without standing up a second process or running token-exchange commands.

**Why this priority**: This is the primary motivator. Self-hosted is Radioso's default deployment shape; removing the standalone-process requirement and the exchange step is the most concrete user-facing win.

**Independent Test**: Bring up the backend in `merged` MCP mode, copy the workspace API token from the dashboard, paste both the MCP URL (same origin as the dashboard) and the API token into Cursor's MCP config, and connect successfully without invoking any exchange script.

**Acceptance Scenarios**:

1. **Given** a backend running with merged MCP mode enabled, **When** an MCP client connects to `{backend-host}/mcp` with `Authorization: Bearer radioso_…`, **Then** the request is authenticated against the workspace API token directly and tool calls proceed.
2. **Given** merged mode, **When** the dashboard's MCP channel card renders, **Then** the displayed endpoint URL matches the backend origin and the snippet instructions tell the user to paste the workspace API token directly (no exchange step).
3. **Given** merged mode, **When** a client sends a write tool call that is policy-gated for approval, **Then** the approval flow still applies and is audited just as it is in standalone mode.

---

### User Story 2 - SaaS / Public Connector Operator: Standalone Deployment (Priority: P2)

A SaaS operator who wants to expose MCP publicly (for Anthropic, OpenAI, or ChatGPT cloud connectors) while keeping the Radioso backend internal can continue running the standalone MCP HTTP server with its existing token-exchange auth.

**Why this priority**: The standalone deployment must remain a first-class supported mode. Removing it would block public-connector use cases and existing deployments.

**Independent Test**: Deploy the standalone MCP package against an existing Radioso backend, exchange a workspace token for an MCP access token, and connect from a remote MCP client using the short-lived bearer.

**Acceptance Scenarios**:

1. **Given** the standalone MCP server is running against a Radioso backend, **When** a client calls `POST /v1/auth/exchange`, **Then** it receives an MCP access token whose TTL respects `RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS`.
2. **Given** standalone mode, **When** the dashboard's MCP channel card is configured with a `NEXT_PUBLIC_MCP_URL` pointing at a different origin than the backend, **Then** the card renders the exchange-required instructions and snippet.
3. **Given** standalone mode, **When** an MCP request arrives at the standalone server, **Then** workspace identity is negotiated against the backend's `GET /api/v1/workspace/mcp/context` as today.

---

### User Story 3 - Hybrid Operator: Both Modes In One Deployment (Priority: P3)

An operator can run merged MCP for internal users (dashboard, internal scripts) and a separate standalone MCP for public connectors, both pointing at the same workspace state, without forking config or code.

**Why this priority**: Hybrid is rarer but valuable for organizations that want a single dashboard install to serve both internal and external MCP traffic with different exposure profiles.

**Independent Test**: Run the backend in merged mode and a standalone MCP server simultaneously; verify the same workspace tokens work in both and that audit/approval state is consistent (when a shared Redis store is configured).

**Acceptance Scenarios**:

1. **Given** a backend with merged MCP enabled and a standalone MCP server pointing at the same backend, **When** a write tool is approved through one entry point, **Then** the approval is honored consistently if Redis is shared and is correctly isolated when in-memory.
2. **Given** hybrid mode, **When** an operator inspects audit logs, **Then** entries record which entry point handled the request (merged vs. standalone) so traffic shape is debuggable.

### Edge Cases

- A request hitting `/mcp` on the backend when merged mode is **disabled** must return `404`, not a half-functional response.
- A workspace API token revoked while a long-lived MCP session is open must invalidate subsequent tool calls.
- A misconfigured `NEXT_PUBLIC_MCP_URL` (e.g. pointing at a standalone server that is down) must surface a clear inline error in the channel card rather than silently showing stale instructions.
- The MCP route must not be mounted under the OpenAPI surface (`/api/v1/...`) — it is a peer transport, not an API namespace.
- CORS for the merged `/mcp` route must be configured separately from the dashboard's session-cookie CORS, because MCP clients send bearer tokens and may originate from arbitrary hosts.
- The merged mount must not bypass the per-workspace policy file (`RADIOSO_MCP_WORKSPACE_POLICIES_PATH`) — both modes must consult the same policy layer.
- Audit log destinations (`RADIOSO_MCP_AUDIT_LOG_PATH`) must continue to work in merged mode; if unset, audit events must flow through the backend's existing structured logging.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector`; this feature MUST NOT introduce a new persistence layer.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic.
- Secrets MUST be stored in `.env` and never committed; `.env.example` MUST be updated for new configuration knobs (`RADIOSO_MCP_ENABLED` and `RADIOSO_MCP_STANDALONE`, etc.).
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- This feature MUST NOT introduce new runtime dependencies on the backend without an explicit dependency-review note in the plan.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: `packages/radioso-mcp-server` remains the owner of MCP protocol handling, tool catalog, auth verification, and approval/audit semantics. The backend MUST consume this package as a library — it MUST NOT reimplement MCP request handling or duplicate the tool catalog.
- **Encapsulation Rule**: The shared package MUST expose a request-handler factory that is transport-agnostic (it takes a request and returns a response) so the standalone CLI and the backend Express mount call into the same code path. The CLI MUST become a thin adapter; the backend mount MUST be a thin Express middleware adapter.
- **New Seams Required**:
  - `packages/radioso-mcp-server`: a `createMcpRequestHandler(config)` factory that returns a framework-agnostic handler plus a small Express adapter helper.
  - `backend/`: a composition-level registration that mounts the handler at `POST /mcp` (and the SSE counterpart) when `RADIOSO_MCP_ENABLED=true` and `RADIOSO_MCP_STANDALONE=false`.
  - Shared config schema for MCP configuration so the backend reads the same env vars the standalone package already uses.
- **Auth Seam**: The handler factory MUST accept a pluggable token verifier so merged mode can verify workspace API tokens directly (no exchange) and standalone mode can keep verifying exchanged short-lived tokens. The verifier is the only mode-specific surface; everything downstream (tool execution, approvals, audits) is shared.
- **Anti-Goals**:
  - Do NOT remove the standalone HTTP server or its `/v1/auth/exchange` flow.
  - Do NOT change the MCP tool catalog or the per-workspace policy schema as part of this feature.
  - Do NOT couple merged mode to a specific HTTP framework feature that the standalone CLI cannot replicate.
  - Do NOT auto-enable merged mode in existing deployments. Operators MUST opt in.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `packages/radioso-mcp-server` MUST expose a transport-agnostic `createMcpRequestHandler(config)` factory plus an Express adapter helper, with parity for the existing standalone CLI behavior.
- **FR-002**: The backend MUST support `RADIOSO_MCP_ENABLED` and `RADIOSO_MCP_STANDALONE` env vars. Both default to `false`. `RADIOSO_MCP_ENABLED=true` with `RADIOSO_MCP_STANDALONE=false` mounts the MCP handler in-process; `RADIOSO_MCP_STANDALONE=true` skips the backend mount for standalone deployments; `RADIOSO_MCP_ENABLED=false` returns 404 on `/mcp`.
- **FR-003**: In merged mode, the auth verifier MUST accept `Authorization: Bearer <workspace-api-token>` directly and resolve workspace identity from the workspace token record, with no exchange step.
- **FR-004**: In standalone mode, the existing `/v1/auth/exchange` flow MUST continue to work unchanged.
- **FR-005**: In merged mode, the MCP route MUST be mounted at `POST /mcp` (plus matching SSE response handling per the MCP Streamable HTTP transport spec) and MUST NOT live under `/api/v1/`.
- **FR-006**: Approval gating, audit logging, workspace policy enforcement, and Redis-backed session storage MUST behave identically in merged and standalone modes.
- **FR-007**: The backend MUST emit MCP-attributed chat traffic with the same signed-header verification that exists today, so history attribution remains correct in both modes.
- **FR-008**: CORS policy for `/mcp` MUST be configurable independently from the dashboard's session CORS policy, including a sensible default that accepts bearer auth from any origin while rejecting cookie-bearing requests.
- **FR-009**: The dashboard's MCP channel card MUST detect "merged" mode when `NEXT_PUBLIC_MCP_URL` resolves to the same origin as the dashboard, and switch its instructions to "paste your workspace API token directly" without the exchange step. When the origins differ, it MUST keep the current exchange-required instructions.
- **FR-010**: Documentation MUST cover all three deployment modes (same-host backend MCP, standalone, hybrid), the env-var matrix, when to choose each, and the security implications (e.g. exposing `/mcp` publicly when the backend is also public).
- **FR-011**: Existing standalone-mode integration tests MUST continue to pass without modification; new integration tests MUST cover the merged mount end-to-end including approval and audit flows.
- **FR-012**: Health and readiness probes MUST report MCP mount status in merged mode so operators can verify the route is live.

### Configuration Surface

- `RADIOSO_MCP_ENABLED`: boolean, default `false`
- `RADIOSO_MCP_STANDALONE`: boolean, default `false`
- `RADIOSO_MCP_MOUNT_PATH`: default `/mcp`, overridable for operators with reverse-proxy conventions.
- `RADIOSO_MCP_MERGED_CORS_ORIGINS`: comma-separated allowlist, default `*` with credentials disabled.
- Existing standalone env vars (`RADIOSO_MCP_BIND_HOST`, `RADIOSO_MCP_BIND_PORT`, signing secret, TTLs, policy path, audit path, Redis URL, etc.) MUST be reused verbatim by merged mode where applicable — operators MUST NOT need to duplicate config.

### Frontend Tasks

- Update the MCP channel card to detect same-origin vs. cross-origin MCP URL and render mode-appropriate instructions and JSON snippet (merged path uses workspace API token directly; cross-origin path keeps the placeholder + exchange-guide reference).
- Add a small inline label on the card ("Same-host setup" / "Remote setup") so operators understand which path they're seeing.
- No new dashboard settings UI is required for this feature — mode is set via deployment env vars.

### Key Entities

- **MCP Request Handler**: A framework-agnostic factory that turns a parsed HTTP request and config into an MCP response, owning protocol semantics, tool dispatch, approval/audit, and session storage.
- **Token Verifier**: A pluggable strategy that maps an incoming `Authorization` header to a workspace identity. Two implementations: `workspaceApiTokenVerifier` (merged mode) and `exchangedAccessTokenVerifier` (standalone mode).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, a backend started with `RADIOSO_MCP_ENABLED=true` and `RADIOSO_MCP_STANDALONE=false` serves a successful MCP `tools/list` call at `POST /mcp` authenticated with a plain workspace API token, end-to-end, without invoking `/v1/auth/exchange`.
- **SC-002**: In validation, the standalone MCP HTTP server continues to pass its existing `smoke:http` and `smoke:redis` suites without code changes.
- **SC-003**: In validation, approval-required write tools in merged mode follow the same approval lifecycle states as in standalone mode (pending → approved → executed → audited).
- **SC-004**: In validation, the MCP channel card in a merged deployment shows the simplified two-step instructions (paste URL + paste workspace token) instead of the three-step exchange instructions.
- **SC-005**: In validation, hybrid deployments with a shared Redis store demonstrate consistent session and approval state across both entry points.
- **SC-006**: In validation, disabling MCP entirely (`RADIOSO_MCP_ENABLED=false`) results in `404` on `/mcp` and the channel card surfaces a clear "MCP is not enabled on this deployment" empty state.

## Out of Scope

- Native OAuth or OpenID Connect flows for ChatGPT/Claude cloud connectors. The current `/v1/auth/exchange` flow is preserved as-is for standalone deployments and is the recommended path for public connector scenarios.
- Changes to the MCP tool catalog, policy schema, or per-workspace permission semantics.
- Publishing `@radioso/mcp-server` to npm. The package remains private; merged mode consumes it as a workspace dependency.
- Frontend UX for token exchange (no in-dashboard "Generate access token" button is added in this scope).
- Performance work (request throughput, connection pooling) beyond ensuring the merged mount does not introduce regressions on the existing backend benchmarks.
