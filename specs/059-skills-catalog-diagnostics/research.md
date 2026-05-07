# Research: Skills Catalog Diagnostics

## Decision: Start With A Read-Only Catalog

Expose skill discovery as read-only metadata before adding generic execution.

**Rationale**: Existing assistant, retrieval, document, SDK, and MCP surfaces already own execution contracts. A catalog can describe those surfaces without destabilizing them. This also lets future specs add execution only after names, capabilities, and diagnostics are stable.

**Alternatives considered**:

- Add `POST /api/v1/skills/{skillName}/execute` now. Rejected because it would blur the assistant/retrieval boundary and force execution semantics before the catalog model is proven.
- Only document skills with no API. Rejected because SDK and MCP clients need a machine-readable discovery surface.

## Decision: Add A Focused Backend Skills Module

Create a backend skills module for catalog entries, diagnostic definitions, and catalog assembly.

**Rationale**: Retrieval, assistant, documents, and MCP should not own the global skill vocabulary. A focused module keeps the product model separate from existing execution modules while still allowing each skill entry to reference current contracts.

**Alternatives considered**:

- Put catalog entries in route handlers. Rejected because routes should stay transport-only.
- Put catalog entries in retrieval. Rejected because retrieval is one skill family, not the catalog owner.
- Put catalog entries only in application composition. Rejected because composition should assemble defaults, not own product semantics.

## Decision: Wire Default Metadata Through Composition

Application composition should expose the default skill catalog and allow future modules to contribute catalog entries.

**Rationale**: Skills describe application-wide capabilities. Optional modules will eventually need to add or hide entries based on composition. Composition is the existing place for app-wide registries and extension points.

**Alternatives considered**:

- Static singleton imported by routes. Rejected because it would not fit future optional modules.
- Database-backed catalog. Rejected for this feature because built-in metadata is static and no operator editing is required.

## Decision: Use Existing Capability Catalog Names

Skill catalog entries should list required capabilities by shared capability policy names.

**Rationale**: Capabilities are the internal permission/control model. Skills are product-facing. Keeping the mapping explicit prevents duplicate permission vocabularies.

**Alternatives considered**:

- Invent skill-local permission strings. Rejected because it would create two authorization vocabularies.
- Omit capability metadata until execution exists. Rejected because capability fit is part of discovery.

## Decision: Define Diagnostics Before Emitting Strategy-Aware Retrieval

Add shared diagnostic definitions now, but do not change retrieval strategy execution in this feature.

**Rationale**: Diagnostics are the guardrail for future probabilistic skill behavior. Defining them now lets retrieval strategy work use the same vocabulary later.

**Alternatives considered**:

- Add retrieval strategy selection immediately. Rejected because it is a separate behavior change with ranking and answer-quality risk.
- Leave diagnostics fully retrieval-specific. Rejected because deterministic skills also need a common execution record shape.

## Message-Queue Impact Review

This feature adds read-only metadata and public API contract discovery. It does not create, modify, enqueue, retry, or consume document processing work.

No changes are required for:

- document worker dispatch
- AMQP payload shape
- retry semantics
- queue tests
- queue documentation
