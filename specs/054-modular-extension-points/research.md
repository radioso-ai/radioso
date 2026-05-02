# Research: Modular Extension Points

## Decision: Add A Focused Composition Layer Instead Of A New Package

**Rationale**: The existing backend already has a clear application/server boundary under `backend/src/app/`. The current hotspot is dependency assembly, not package ownership. A focused `backend/src/app/composition/` layer can introduce module registration and default composition without forcing a repository-wide package split.

**Alternatives considered**:

- Create a new `packages/radioso-core` package: rejected for this feature because it would require broad import rewrites before proving the extension seams.
- Keep all wiring in `backend/src/app/server/dependencies.ts`: rejected because the file already owns too many deployment and adapter choices.

## Decision: Use A Neutral Capability Policy With Default-Allow Behavior

**Rationale**: The feature needs a consistent way to check whether an action is available without changing current behavior. A default-allow policy preserves the product while enabling tests for stricter deployments. Capability names should come from a canonical catalog so checks remain searchable and auditable.

**Alternatives considered**:

- Hard-code checks in routes: rejected because it spreads policy decisions across transport code.
- Use existing abuse control only: rejected because abuse control handles rate/usage safety, while capability policy answers whether a named product action is available.

## Decision: Reuse Existing Domain-Specific Ports Where They Are Already Good Enough

**Rationale**: Connector plugins, document storage, document job dispatch, analytics sinks, incident sinks, telemetry sinks, and retrieval stages already exist as identifiable seams. The feature should strengthen and compose those seams rather than replacing them with a parallel abstraction.

**Alternatives considered**:

- Create one generic plugin interface for all extension types: rejected because connectors, sinks, retrieval stages, and storage adapters have different lifecycles and safety needs.
- Refactor every service constructor in one pass: rejected because it would create high regression risk without improving the default composition guarantee.

## Decision: Keep Default Composition Verifiable Without Optional Modules

**Rationale**: The most important regression risk is accidental dependency on an optional module or deployment-specific configuration. Dedicated build and focused tests should prove the default composition is standalone.

**Alternatives considered**:

- Rely on existing backend tests only: rejected because existing tests may not catch optional imports in the default entry point.
- Add runtime smoke testing only: rejected because compile/build validation should catch missing optional dependencies earlier.

## Decision: Do Not Change Public HTTP Contracts Unless A Guarded Action Requires It

**Rationale**: This feature is architecture preparation. Public API behavior should remain stable unless a representative capability-denial path requires a typed error shape. If any HTTP shape changes, the code-first OpenAPI registry must be updated and generated artifacts regenerated.

**Alternatives considered**:

- Add new module-management endpoints: rejected as out of scope because no user-facing module management is required.
- Add dashboard UI for module status: deferred unless planning discovers an existing settings/admin need.

## Decision: Documentation Is Part Of The Architecture Boundary

**Rationale**: Extension boundaries are easy to erode. A concise maintainer/operator guide should define the supported extension categories, ownership rules, default behavior, and anti-goals so future reviews have a stable reference.

**Alternatives considered**:

- Leave guidance only in tests: rejected because future contributors need a readable architecture explanation.
- Put all guidance in the root README: rejected because this is detailed maintainer/operator architecture content; the README should link or summarize if needed.
