# Research: MCP Context Server

## Decision: Ship the first release as a standalone stdio MCP server package

**Rationale**: Stdio keeps the deployment and security model simple, matches the "separate process" requirement, and is supported by major MCP-capable coding clients. It provides immediate value without pulling remote transport concerns into the first cut.

**Alternatives considered**:
- Streamable HTTP in v1: more distribution upside, but higher auth, transport, and QA complexity for the first release.
- Embedding MCP routes inside the backend: rejected because it violates the standalone boundary and increases mutual dependency risk.

## Decision: Use the Radioso HTTP contract through a focused client adapter

**Rationale**: The user explicitly asked for minimal code-level mutual dependency. Calling the existing HTTP contract through the first-party SDK or a thin package-local client adapter preserves a stable seam and keeps MCP concerns out of backend modules.

**Alternatives considered**:
- Direct imports from backend service modules: rejected because it tightly couples package internals to backend implementation.
- Direct database access from the MCP package: rejected because it bypasses authorization and validation boundaries.

## Decision: Expose a small tool catalog with both read and write operations

**Rationale**: A narrow tool set is enough to prove the product wedge while keeping behavior auditable and testable. The first release should cover grounded answers, document reads, and document lifecycle writes.

**Alternatives considered**:
- Mirror every Radioso API over MCP: rejected because it bloats the surface without improving the initial value.
- Read-only tools only: rejected because the request explicitly asks for both read and write paths.

## Decision: Support write-path settings updates through a safe merge pattern

**Rationale**: Existing settings APIs require full payloads. The MCP package can keep the tool ergonomic by reading current settings, applying a validated patch, and sending the merged result back through the existing update endpoint.

**Alternatives considered**:
- Require clients to send the full settings object: rejected because it is brittle and unnecessarily high-friction.
- Skip all settings writes: rejected because the approved spec calls for at least one supported workspace operation beyond document CRUD.

## Decision: Keep MCP tool results structured and human-readable

**Rationale**: Agents benefit from consistent structured outputs, while humans debugging through MCP inspectors benefit from readable summaries. Tool handlers should return a concise text summary plus the machine-usable payload.

**Alternatives considered**:
- Text-only outputs: rejected because downstream automation becomes more fragile.
- Raw backend payload passthrough with no summary: rejected because debugging and inspection quality degrades.
