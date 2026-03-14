# Research: Document List Polish

## Decision 1: Use Hard Delete on Documents with Account-Scoped Predicate

- **Decision**: Add a delete operation that removes a document row by `{documentId, accountId}` and relies on existing foreign key cascade to remove dependent chunks.
- **Rationale**: The approved scope explicitly excludes soft delete and restore flows. Account-scoped predicate enforces FR-008 and aligns with existing bearer-auth patterns.
- **Alternatives considered**:
  - Soft-delete flag and filtered queries: rejected because it expands scope into trash/restore behavior.
  - Deletion by `documentId` only: rejected because it risks cross-account data access.

## Decision 2: Introduce a Focused Backend Deletion Service Instead of Growing Route Logic

- **Decision**: Implement delete orchestration in a dedicated `DocumentDeletionService` and keep `documentRoutes.ts` transport-only.
- **Rationale**: Constitution section VI requires explicit layer ownership and avoiding god files. Deletion rules and auditing belong in orchestration/domain, not route handlers.
- **Alternatives considered**:
  - Put delete logic directly in `documentRoutes.ts`: rejected due transport-layer violation.
  - Add delete behavior into `DocumentIngestionService`: feasible but less clear ownership than a focused seam.

## Decision 3: Map Internal Status to a Single User-Facing Status Label + Icon

- **Decision**: Add a small frontend status helper/component that maps backend status to one plain-language label and one icon.
- **Rationale**: FR-003/FR-004 require one readable status treatment and removal of duplicate labels. Central mapping keeps row rendering simple and consistent.
- **Alternatives considered**:
  - Render raw backend `status` and `ragStatus`: rejected because it duplicates/conflicts today.
  - Hide one status with CSS only: rejected because semantics remain duplicated.

## Decision 4: Keep Citation-Failure Feedback in Chat Citation Rendering

- **Decision**: Citation click flow performs a document fetch check; missing source yields an inline unavailable-source message in chat citation UI while keeping the message context in place.
- **Rationale**: Matches the architecture constraint that chat citation rendering owns activation feedback, and satisfies FR-010/FR-011.
- **Alternatives considered**:
  - Global route-level fallback in dashboard shell: rejected because it moves citation behavior out of citation owner.
  - Silent no-op on 404: rejected because it fails clarity and trust requirements.

## Decision 5: Backend-First TDD for Delete Contract and Domain Behavior

- **Decision**: Write failing contract/unit/integration backend tests for deletion behavior before implementation, then implement and rerun tests.
- **Rationale**: Constitution section II is non-negotiable for backend changes.
- **Alternatives considered**:
  - Implement first then test: rejected by constitution.
