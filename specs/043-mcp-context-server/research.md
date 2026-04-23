# Research: Remote MCP Context Server

## Decision: Use Streamable HTTP as the remote MCP transport

**Rationale**: Official MCP guidance treats Streamable HTTP as the remote transport surface for hosted servers. Using the standard transport keeps the package compatible with remote MCP clients and avoids inventing a Radioso-specific protocol.

**Alternatives considered**:
- Keep stdio only: rejected because it does not satisfy the hosted remote product goal.
- Build a custom JSON RPC HTTP server without MCP transport helpers: rejected because it adds avoidable protocol risk and reduces interoperability.

## Decision: Use package-issued short-lived MCP access tokens instead of forwarding Radioso workspace tokens to clients

**Rationale**: The MCP package should own the client-facing credential while keeping the upstream Radioso workspace token server-side. This creates a clean trust boundary, allows per-session capability narrowing, and prevents raw upstream credentials from becoming the MCP auth mechanism.

**Alternatives considered**:
- Pass the Radioso workspace token through every MCP request: rejected because it leaks upstream credential semantics into the protocol surface and makes policy narrowing much weaker.
- Bake one static MCP token into server config: rejected because it does not support per-workspace session exchange and is operationally brittle.

## Decision: Use token exchange plus in-memory session storage for the first remote milestone

**Rationale**: A package-owned token-exchange endpoint is enough to make the remote server functional now, while in-memory stores keep the package self-contained and easy to extract. Putting the stores behind interfaces preserves the upgrade path to Redis or another distributed store.

**Alternatives considered**:
- Full hosted OAuth control plane in this milestone: rejected because it is a broader product surface than the user asked for right now.
- Stateless signed access tokens with no server-side session record: rejected because capability narrowing, approval revocation, and audit correlation become harder than necessary in the first cut.

## Decision: Govern write tools with both capability policy and explicit approval grants

**Rationale**: Remote write paths need a second gate beyond upstream token validity. Capability policy prevents unsafe tool exposure up front, while approval grants make writes deliberate and auditable at execution time.

**Alternatives considered**:
- Expose all write tools whenever the upstream workspace token can use them: rejected because it is too permissive for a hosted automation surface.
- Require approval for every tool, including reads: rejected because it adds friction without commensurate safety value.

## Decision: Keep capability discovery session-aware

**Rationale**: The tool list should reflect the actual granted capabilities for the current access session, not just the global server catalog. This avoids trial-and-error on denied tools and gives operators a predictable remote surface.

**Alternatives considered**:
- Return the full server tool catalog to every caller: rejected because it hides policy reality and produces avoidable authorization failures.
- Hide denied tools only at execution time: rejected because it creates a poor operator experience and less clear audits.

## Decision: Emit structured package-owned audit events

**Rationale**: Auth exchange, policy denials, approval issuance, and tool execution outcomes are MCP-surface events. The package needs its own structured audit trail so operators can understand what happened without depending on backend internals that never saw the caller's remote auth or approval state.

**Alternatives considered**:
- Rely only on backend audit events: rejected because the backend does not own exchange, approval, or capability decisions.
- Log free-form strings only: rejected because structured search, later export, and automated review are much weaker.

## Decision: Preserve the monorepo now, but reorganize the package for near-term extraction

**Rationale**: Staying in the monorepo keeps iteration fast and preserves shared tooling, while clear package-local module seams make later extraction inexpensive.

**Alternatives considered**:
- Move to a new repository immediately: rejected because it slows delivery before the shape is hardened.
- Keep the package flat and monorepo-coupled: rejected because it makes future extraction much more expensive.
