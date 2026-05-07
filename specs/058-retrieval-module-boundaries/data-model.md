# Data Model: Retrieval Module Boundaries

This feature does not add persistent data, database tables, API payloads, queue payloads, or frontend state. The entities below are architecture concepts used to guide implementation and review.

## Retrieval Public Surface

**Represents**: The intentional entrypoint for production code outside retrieval to consume retrieval-owned exports.

**Key attributes**:

- Exported request/result contracts
- Exported trace and diagnostic contracts
- Exported public services
- Exported chunking contracts and strategy constructors used by app wiring
- Exported search-text and subject helpers used by document workflows
- Exported LLM gateway adapters used by provider registration

**Validation rules**:

- Must not contain product logic.
- Must not re-export every retrieval file by default.
- Must include only symbols with legitimate production consumers outside retrieval.

## Retrieval Internal Module

**Represents**: Retrieval domain, service, or infrastructure code that remains private to retrieval unless deliberately promoted.

**Key attributes**:

- Source path under `backend/src/modules/retrieval/domain/**`
- Source path under `backend/src/modules/retrieval/services/**`
- Source path under `backend/src/modules/retrieval/infra/**`

**Validation rules**:

- May be imported freely by retrieval-internal files.
- Must not be imported directly by production files outside retrieval.
- May be imported directly by tests during the first enforcement pass.

## Production Consumer

**Represents**: Backend production source outside retrieval that needs retrieval-owned symbols.

**Key attributes**:

- App composition and server dependency wiring
- HTTP routes, presenters, and OpenAPI source
- Chat services and chat response types
- Document processing and search services
- Audit services
- Settings domain where chunking options cross module boundaries
- Shared LLM provider registry

**Validation rules**:

- Must import retrieval-owned symbols from approved retrieval root entry points.
- Must not import retrieval domain, service, or infrastructure internals directly.

## Boundary Rule

**Represents**: Automated validation that distinguishes allowed and forbidden retrieval imports.

**Key attributes**:

- Source scope: backend production source outside retrieval
- Forbidden targets: retrieval domain, service, and infrastructure internals
- Allowed targets: approved retrieval root entry points
- Exclusions: backend tests, built output, generated OpenAPI output

**Validation rules**:

- Must fail on a representative direct production import from retrieval internals.
- Must pass after production imports use approved retrieval root entry points.

## State Transitions

1. **Current state**: Production consumers import retrieval internals directly.
2. **Red validation state**: Boundary lint exists and fails on current direct production imports.
3. **Migrated state**: Approved root entry points exist and production imports use them.
4. **Enforced state**: Boundary lint passes locally and in CI, and future direct imports fail.
