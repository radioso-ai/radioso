# Data Model: Remote MCP Context Server

> **Amendment 2026-05-19**: The `ApprovalGrant` record and `approvalTtlSeconds` config field have been removed along with the server-side approval flow. The remaining persisted state is sessions; `approvalRequiredWriteTools` survives only as policy metadata that drives the `requiresApproval: true` tool-list annotation.

## MCP Server Config

- **baseUrl**: Radioso server origin used for all upstream HTTP calls.
- **bindHost**: Host interface for the package-owned HTTP server.
- **bindPort**: Port for the package-owned HTTP server.
- **serverName**: Visible name for the MCP server instance.
- **signingSecret**: Secret used for package-owned token signing or session token derivation.
- **accessTokenTtlSeconds**: Lifetime for exchanged MCP access tokens.
- **approvalTtlSeconds**: Lifetime for approval grants.
- **allowedReadTools**: Global allowlist for read tools.
- **allowedWriteTools**: Global allowlist for write tools.
- **approvalRequiredWriteTools**: Subset of write tools that require approval grants.
- **auditLogPath**: Optional JSONL output path for structured audit events.
- **requestTimeoutMs**: Upstream Radioso request timeout.

**Validation rules**
- `baseUrl` must be a valid absolute HTTP or HTTPS URL.
- `bindPort` must be a valid TCP port.
- `signingSecret` must be non-empty in remote mode.
- Any configured tool names must map to the package tool catalog.

## MCP Access Session

- **sessionId**: Opaque unique identifier for the exchanged session.
- **accessTokenHash**: Stored hash or opaque lookup key for the issued MCP access token.
- **upstreamApiToken**: Radioso workspace API token kept only in package-owned server memory.
- **grantedTools**: Exact tool names allowed for this session.
- **grantedProfiles**: Optional named capability profiles granted during exchange.
- **issuedAt**: Session creation timestamp.
- **expiresAt**: Session expiry timestamp.
- **clientName**: Optional client identifier supplied during exchange.
- **workspaceHint**: Optional audit-safe workspace label or identifier if discoverable through upstream validation.

**Relationships**
- One access session can own zero or more approval grants.
- Every tool execution is authorized against one access session.

**Validation rules**
- Expired sessions are invalid for all MCP calls.
- The upstream Radioso token never leaves package-owned memory once exchanged.

## Approval Grant

- **approvalId**: Unique identifier for the grant.
- **sessionId**: Parent access session.
- **approvalTokenHash**: Stored hash or opaque lookup key for the approval token.
- **allowedTools**: Subset of governed write tools covered by the grant.
- **reason**: Operator-supplied purpose for the approval.
- **resourceHints**: Optional document or workspace resource hints for audit context.
- **issuedAt**: Grant creation timestamp.
- **expiresAt**: Grant expiry timestamp.
- **remainingUses**: Optional counter for single-use or limited-use approvals.

**Relationships**
- Approval grants belong to one access session.
- Governed write tools require a matching valid approval grant.

**Validation rules**
- Approval grants must expire no later than their parent access session.
- Approval grants must only include tools already granted to the parent session.

## Capability Policy

- **toolName**: Stable MCP tool identifier.
- **accessMode**: `read` or `write`.
- **enabled**: Whether the runtime can expose the tool at all.
- **requiresApproval**: Whether the tool requires an approval grant at execution time.
- **profiles**: Optional named profiles that group tools for exchange requests.

**Relationships**
- Capability policy is evaluated during auth exchange and again before tool execution.

**Validation rules**
- Disabled tools cannot be granted during exchange.
- Write tools may require both a granted capability and a valid approval grant.

## MCP Tool Capability

- **name**: Stable MCP tool identifier.
- **accessMode**: `read` or `write`.
- **description**: Plain-language contract for the tool.
- **inputSchema**: Validated request shape.
- **approvalRequirement**: `none` or `required`.
- **handler**: Package-local executor that translates the request to Radioso operations.

**Relationships**
- Each tool capability is executed through the Radioso API adapter.
- Capability policy filters which tool capabilities are visible or executable for a session.

## Audit Event

- **eventId**: Unique identifier.
- **timestamp**: ISO-8601 event time.
- **eventType**: `auth.exchange_succeeded`, `auth.exchange_failed`, `approval.issued`, `approval.denied`, `tool.executed`, `tool.denied`, `tool.failed`, `upstream.unsupported_capability`, or similar.
- **sessionId**: Optional access-session identifier.
- **approvalId**: Optional approval-grant identifier.
- **toolName**: Optional tool identifier.
- **outcome**: `success`, `denied`, or `error`.
- **statusCode**: Optional HTTP or mapped upstream status.
- **metadata**: Safe structured context such as client name, granted tools, duration, or resource hints.

**Validation rules**
- Audit events must never include raw access tokens, upstream Radioso tokens, or signing secrets.
- Audit sink failures must not corrupt tool responses.

## Radioso API Adapter

- **client**: Underlying HTTP client for Radioso.
- **workspaceScope**: Implicitly bound by the exchanged upstream workspace token.
- **operations**: Read and write methods mapped to the supported MCP tool catalog.

**Validation rules**
- Adapter methods must preserve workspace scoping.
- Adapter methods must not bypass backend validation or authorization.

## MCP Tool Result

- **summary**: Short human-readable status text.
- **data**: Structured payload returned from Radioso.
- **warnings**: Optional non-fatal notes such as approval expiry nearing or unsupported capability fallback.

**State transitions**
- Request authenticated
- Capability authorized
- Approval validated if required
- Input validated
- Radioso operation executed
- Structured success or structured failure returned
- Audit event emitted
