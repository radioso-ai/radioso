# Research: Enterprise Feature Architecture Boundaries

## Decision: Use Radioso Feature Manifests Instead Of A PostHog-Style Product Tree

**Rationale**: Radioso already has a clear OSS/EE package split and does not need a large `products/` migration. Lightweight manifests let existing EE packages declare ownership for modules, routes, docs, and validation without moving files.

**Alternatives considered**:
- Full `products/` migration: too broad for the current repo size and would mix architecture hardening with a disruptive layout rewrite.
- Keep route/script ownership as-is: cheaper now, but it leaves ownership scattered and does not address the stated PostHog lesson.

## Decision: Decompose Enterprise Backend Registration Into Feature Modules

**Rationale**: The current `ApplicationModule` abstraction already supports multiple modules and deduplication. Keeping feature modules inside `@radioso/enterprise-backend-module` preserves the package boundary while making each Enterprise capability independently inspectable and testable.

**Alternatives considered**:
- Separate npm package per EE feature: too much packaging overhead for the first slice.
- One aggregate module only: preserves behavior but does not improve ownership.

## Decision: Implement Boundary Validation As A Local Node Script

**Rationale**: A local script avoids introducing a dependency before the desired rules settle. It can parse TypeScript import declarations conservatively, validate the concrete rules in the spec, and run in CI or npm scripts. The script can later be replaced by dependency-cruiser or ESLint boundaries if the rule set grows.

**Alternatives considered**:
- dependency-cruiser: strong fit, but adds dependency and config complexity immediately.
- ESLint-only rules: useful for import restrictions, less convenient for repo-level route/manifest validation and temporary exception reporting.

## Decision: Start Public Contracts With Representative Existing Cross-Boundary Dependencies

**Rationale**: EE features currently depend on generic application module types, document ingestion behavior, chat action/contact provider ports, and website embed integration behavior. Public contract barrels in these areas prove the pattern without forcing every module to migrate at once.

**Alternatives considered**:
- Migrate all backend modules to contracts in one pass: too broad and high-risk.
- Document contracts only: insufficient because imports remain pointed at private internals.

## Decision: Keep Generated Enterprise Route Files In `frontend/app`

**Rationale**: Next.js App Router requires route files under `frontend/app`. The existing generator already handles enabling and disabling those files. The improvement is to derive generated files from EE frontend manifests and validate them before writing.

**Alternatives considered**:
- Dynamic route loading from packages without generated files: not compatible with App Router file-system routing.
- Hand-maintained route list: existing behavior, but not feature-owned.

## Message-Queue Impact Review

No document worker dispatch payloads, AMQP queue payloads, retry semantics, queue tests, or queue documentation are affected. This feature changes architecture boundaries, validation, and generated frontend route ownership only.
