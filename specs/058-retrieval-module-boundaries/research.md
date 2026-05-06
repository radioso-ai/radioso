# Research: Retrieval Module Boundaries

## Decision: Use dependency-cruiser for backend source boundary enforcement

**Rationale**: The feature needs a focused import-boundary check, not a broad style linter. dependency-cruiser can parse TypeScript import graphs, match source and target paths, exclude tests and generated output, and run as an npm script in CI. This fits the requirement to fail on production imports from retrieval internals while allowing imports from `backend/src/modules/retrieval/public.ts`.

**Alternatives considered**:

- ESLint import restrictions: familiar, but this backend does not currently have ESLint configured and adding a general lint stack would broaden the feature.
- TypeScript project references: useful for package-scale boundaries, but too heavy for an incremental module pilot inside one backend project.
- Custom script over `rg`: simple but fragile because it would inspect text rather than the resolved import graph.

## Decision: Enforce production source only in the pilot

**Rationale**: The plan intentionally excludes backend tests, generated output, and distribution output. Tests often import internals to cover focused domain behavior, and changing that testing style would expand the pilot. Generated and built artifacts should not be the source of architectural enforcement.

**Alternatives considered**:

- Enforce tests immediately: stronger encapsulation, but it risks weakening focused unit-test ergonomics before the production boundary pattern is proven.
- Enforce only CI and not local scripts: easier to add, but maintainers need a fast local command before pushing.

## Decision: Make `public.ts` a curated re-export surface

**Rationale**: A public entrypoint should declare what retrieval intentionally exposes without creating new runtime behavior. Re-exports preserve existing implementations and keep ownership in retrieval domain, service, and infrastructure files.

**Alternatives considered**:

- Move public symbols into a new package: clearer long-term package boundary, but too large for an incremental pilot.
- Keep direct imports and rely on review: low friction, but does not create a durable or testable boundary.

## Decision: No HTTP, SDK, MCP, database, queue, prompt, or frontend contracts

**Rationale**: This feature is an import-surface refactor and tooling addition. Public runtime contracts are explicitly out of scope. The only design contract is the internal module-boundary contract.

**Alternatives considered**:

- Document in OpenAPI or SDK docs: inappropriate because no external API behavior changes.
- Add module boundaries for chat/documents/settings now: useful future work, but would expand the pilot beyond retrieval.
