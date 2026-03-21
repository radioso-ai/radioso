# Feature Specification: Code-First OpenAPI Contracts

**Feature Branch**: `borohhov/openapi-contract-audit`  
**Created**: 2026-03-21  
**Status**: Draft  
**Input**: User description: "Switch the backend OpenAPI contract to a code-first system and update Speckit guidance so future work uses it"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep Backend API Docs in Sync (Priority: P1)

As a backend engineer, I can change an HTTP route or payload contract in one authoritative place and regenerate the published API spec, so that the checked-in OpenAPI files stay aligned with the implementation.

**Why this priority**: The current manual contract file drifted from the real backend behavior. Without a single source of truth, future API changes will keep breaking documentation reliability.

**Independent Test**: Can be fully tested by changing a documented backend API shape, regenerating the spec, and verifying that the generated contract and contract tests match the implementation without hand-editing the published spec files.

**Acceptance Scenarios**:

1. **Given** a backend API route, request schema, or response shape changes, **When** an engineer updates the authoritative contract source and regenerates the OpenAPI outputs, **Then** the generated OpenAPI files reflect the new behavior without requiring separate manual edits.
2. **Given** the repository contract tests run, **When** the generated spec and implementation drift apart, **Then** the tests fail instead of silently accepting stale documentation.

---

### User Story 2 - Review and Consume the Generated Contract Easily (Priority: P2)

As a developer or reviewer, I can inspect the current backend API contract through generated files and a served docs endpoint, so that I can review the actual contract without reverse-engineering route handlers.

**Why this priority**: A generated contract only helps if engineers can access it easily during development and review.

**Independent Test**: Can be fully tested by generating the OpenAPI outputs and confirming that the backend exposes the current contract in a machine-readable and human-readable form during normal application use.

**Acceptance Scenarios**:

1. **Given** the backend is running in a normal development or deployed environment, **When** an engineer requests the docs endpoint, **Then** they receive the current generated OpenAPI contract rather than a stale static draft.
2. **Given** a reviewer opens the checked-in contract files, **When** they inspect them, **Then** they see outputs generated from the authoritative code-first source.

---

### User Story 3 - Keep Future Feature Work on the Same Contract System (Priority: P3)

As a maintainer using Speckit, I can rely on the repo instructions to tell future feature work to update the code-first contract source instead of hand-editing published spec files, so that the new system remains the default workflow.

**Why this priority**: A one-time implementation does not solve drift if planning and implementation prompts still instruct future work to maintain contracts manually.

**Independent Test**: Can be fully tested by reviewing the repo constitution, plan template, and Speckit prompts and confirming they direct backend API work to the code-first OpenAPI system and generated outputs.

**Acceptance Scenarios**:

1. **Given** a future feature changes backend HTTP behavior, **When** an engineer follows the repo’s Speckit guidance, **Then** the instructions direct them to update the code-first OpenAPI source and regenerate artifacts.
2. **Given** a planner or reviewer checks constitution compliance for backend API work, **When** they review the plan and prompts, **Then** they can verify that generated OpenAPI outputs are treated as artifacts, not hand-authored sources of truth.

### Edge Cases

- A backend API change updates runtime validation but forgets to update the code-first contract source.
- Generated OpenAPI files are edited directly, causing the next generation step to overwrite untracked manual changes.
- Documentation routes add startup or test overhead in environments where docs are not needed.
- The implementation contains inconsistent error response shapes, requiring the generated contract to represent multiple real response formats instead of pretending one uniform shape.
- Speckit planning artifacts describe an API change but fail to translate that approved contract into the runtime code-first registry.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Backend HTTP contract changes MUST use the code-first OpenAPI registry and treat generated OpenAPI files as artifacts rather than hand-authored sources.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Route-local request validation remains owned by HTTP route modules; the code-first OpenAPI registry owns published contract assembly; app bootstrap owns docs exposure; Speckit prompts and templates own workflow guidance for future features.
- **Encapsulation Rule**: `backend/src/app/http/openapi/document.ts` MUST remain the authoritative contract assembly point and MUST NOT be bypassed by hand-edited changes to `backend/openapi.yaml` or `backend/openapi.json`.
- **New Seams Required**: The backend MUST expose a reusable contract generation path, a script that writes generated outputs, a contract drift test, and explicit Speckit guidance for future backend API work.
- **Anti-Goals**: Do not introduce a new backend framework just to generate docs. Do not keep a second manually maintained OpenAPI source beside the code-first registry. Do not let documentation routes alter test behavior or production-sensitive startup paths unnecessarily.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST define the backend OpenAPI contract in a code-first source that lives with the backend codebase rather than in a manually maintained standalone YAML draft.
- **FR-002**: The system MUST generate checked-in OpenAPI artifact files from that authoritative source in both machine-readable and repository-reviewable forms.
- **FR-003**: The system MUST allow backend request and response contract updates to be made through code changes that are reviewable alongside route and schema changes.
- **FR-004**: The system MUST provide an automated verification step that detects drift between the generated OpenAPI artifacts and the authoritative code-first contract source.
- **FR-005**: The system MUST make the current generated backend contract accessible from the running backend in a machine-readable form and a human-readable documentation view outside test-only flows.
- **FR-006**: The system MUST preserve existing backend behavior while replacing the contract maintenance workflow, including keeping route behavior, auth requirements, status codes, and documented payloads aligned with the implementation.
- **FR-007**: The system MUST document backend routes that were previously missing from the shared contract when those routes are part of the supported API surface.
- **FR-008**: The system MUST keep generated OpenAPI artifact files out of the list of hand-maintained sources of truth in developer workflow guidance.
- **FR-009**: The system MUST update Speckit planning and implementation guidance so future backend API changes explicitly use the code-first OpenAPI source and regeneration workflow.
- **FR-010**: The system MUST update repo-level governance so constitution checks and reviews can enforce the code-first backend contract workflow.
- **FR-011**: The system MUST keep test-mode behavior stable by avoiding unnecessary docs-serving overhead in environments where the docs endpoints are not needed.
- **FR-012**: The system MUST keep contract tests aligned with actual backend behavior where previous expectations no longer matched the runtime or test harness behavior.

### Key Entities *(include if feature involves data)*

- **Code-First OpenAPI Registry**: The authoritative backend contract source that defines paths, schemas, security requirements, and responses for the published API.
- **Generated OpenAPI Artifacts**: The checked-in OpenAPI output files derived from the registry and used for review and downstream consumption.
- **Contract Drift Check**: Automated validation that fails when the generated artifacts and the authoritative registry disagree.
- **Docs Exposure Surface**: The backend endpoints that serve the generated contract in machine-readable and human-readable forms.
- **Speckit Guidance Surface**: The constitution, plan template, and prompts that tell future feature work how to maintain backend API contracts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Backend API contract changes can be completed by updating the code-first contract source and regenerating artifacts, with no manual edits required in the published OpenAPI files.
- **SC-002**: Contract drift between backend implementation and published OpenAPI artifacts is caught automatically in backend validation.
- **SC-003**: Engineers can access the current backend contract through generated repository artifacts and a served docs surface without consulting a stale draft file.
- **SC-004**: Future Speckit-driven backend API work is explicitly guided toward the code-first OpenAPI workflow in repo-level instructions and templates.
- **SC-005**: The resulting workflow reduces contract drift by making the generated OpenAPI files artifacts of backend code changes rather than parallel documentation work.

## Assumptions

- The repo’s existing backend Zod validation schemas are sufficient to serve as the starting point for a code-first contract workflow.
- Some response schemas may remain broader than ideal until all runtime response shapes are normalized, but the contract should still describe real current behavior rather than stale draft assumptions.
- Retroactive Speckit artifacts for this work are acceptable even though the implementation preceded the spec and plan.
