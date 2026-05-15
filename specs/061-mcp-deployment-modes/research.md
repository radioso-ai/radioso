# Research: MCP Server Deployment Modes

## Decision: Package-owned request handler factory

The MCP package remains the owner of Streamable HTTP protocol handling, tool catalog filtering, approval enforcement, audit emission, and Radioso API adapter construction. The backend will import a package-level `createMcpRequestHandler` factory and an Express adapter helper rather than rebuilding MCP routing in backend code.

Rationale: this keeps standalone and merged traffic on the same implementation path and satisfies the boundary rule in the spec.

Alternatives considered: duplicating a backend `/mcp` route was rejected because it would fork protocol handling and policy behavior.

## Decision: Pluggable token verifier

The shared handler accepts a verifier that maps a bearer token to an MCP access-session record. Standalone mode uses the existing exchanged-token session store. Merged mode verifies the workspace API token directly through backend auth services on every request and creates an ephemeral request session.

Rationale: workspace token revocation invalidates subsequent merged requests, while standalone mode keeps the existing short-lived token exchange flow.

Alternatives considered: auto-exchanging workspace tokens inside backend was rejected because it preserves the setup friction this feature removes.

## Decision: Backend mount owns only wiring

Backend code adds environment parsing, a small MCP config mapper, direct workspace-token verifier, CORS handling, and an Express mount at the configured path. Product rules remain in the MCP package and existing backend auth/workspace services.

Rationale: `backend/src/app/composition/` and `backend/src/app/server/` are responsible for runtime wiring; MCP domain behavior stays package-owned.

## Decision: Message queue impact

This feature changes an MCP transport contract and backend runtime mounting, but it does not change document worker dispatch, AMQP payload shape, retry semantics, or queue processing behavior.

Rationale: MCP tools continue to call existing backend HTTP APIs for document operations. Existing document worker enqueue paths are untouched.

## Decision: Documentation targets

Update `.env.example`, `readme.md`, `docs/mcp-client-setup.md`, and `packages/radioso-mcp-server/README.md`.

Rationale: the feature changes deployment modes, operator env vars, and dashboard connection instructions.
