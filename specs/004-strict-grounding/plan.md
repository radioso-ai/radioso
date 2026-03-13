# Implementation Plan: Strict Grounding

**Branch**: `004-strict-grounding` | **Date**: 2026-03-14 | **Spec**: [/tmp/hivec-strict-grounding/specs/004-strict-grounding/spec.md](/tmp/hivec-strict-grounding/specs/004-strict-grounding/spec.md)
**Input**: Feature specification from `/specs/004-strict-grounding/spec.md`

## Summary

Make document-grounded chat honor each account's configured similarity threshold
as a hard floor, raise the default first-pass candidate count modestly to
protect recall, preserve the current chat API contract, and prove the behavior
with failing-first backend tests that cover both out-of-corpus refusal and
document-backed answerability.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22  
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Vitest, Supertest  
**Storage**: PostgreSQL 16+ with `pgvector`; filesystem-backed Speckit artifacts  
**Testing**: Vitest and Supertest  
**Target Platform**: Linux server for backend API and retrieval services  
**Project Type**: Web application with `backend/` and `frontend/` workspaces  
**Performance Goals**: Preserve current chat response behavior and request
latency envelope without adding extra LLM calls or transport hops  
**Constraints**: No schema changes, no chat API schema changes, no silent rewrite
of stored account settings, and no retrieval-policy logic in HTTP routes  
**Scale/Scope**: Narrow backend-only change touching retrieval policy, default
settings, and a focused set of backend tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved for implementation within this isolated worktree.
- Backend work will follow TDD with failing tests before implementation.
- Stack remains Node.js for backend and React for frontend; no stack changes.
- Database remains PostgreSQL with `pgvector`; no schema changes are planned.
- GPT-5.2 remains the default LLM provider.
- No new secrets or environment variables are introduced.
- Customer-data handling is unchanged; auditability is preserved through the
  existing chat refusal and retrieval diagnostics paths.
- Module boundaries are explicit: transport stays in Express routes and
  presenters, orchestration stays in `ChatService`, retrieval policy stays in
  retrieval services, and persistence remains in repositories.
- Existing responsibility-limited files are preserved by keeping threshold
  policy out of routes and by limiting chat orchestration changes to the
  existing call-or-refuse decision point.
- No refactor story is required before feature work because the target seams are
  already clear and narrow.

## Project Structure

### Documentation (this feature)

```text
specs/004-strict-grounding/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── chat-grounding.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── presenters/
│   │   └── routes/
│   ├── modules/chat/services/
│   ├── modules/retrieval/services/
│   └── modules/settings/domain/
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
└── app/
```

**Structure Decision**: This feature is implemented entirely in the backend
workspace. HTTP routes and presenters remain transport-only, `ChatService`
remains orchestration-only, retrieval threshold policy remains in
`backend/src/modules/retrieval/services/`, and default retrieval configuration
remains in `backend/src/modules/settings/domain/`. No frontend changes are
planned.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/chatRoutes.ts` and
  `backend/src/app/http/presenters/chatPresenter.ts`
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts`
- **Domain Layer**: `backend/src/modules/retrieval/services/retrievalPipelineService.ts`,
  `backend/src/modules/retrieval/services/rerankService.ts`, and
  `backend/src/modules/settings/domain/retrievalSettings.ts`
- **Persistence/Integration Layer**: `backend/src/modules/retrieval/infra/vectorSearch.ts`,
  database repositories, and OpenAI gateways
- **Files Kept Small**: `chatRoutes.ts` stays request-shape only,
  `chatPresenter.ts` stays response-shape only, and `chatService.ts` must not
  absorb vector-search threshold policy
- **Planned Extractions**: Introduce a focused retrieval-policy helper only if
  test-driven changes make `retrievalPipelineService.ts` harder to reason about;
  otherwise keep the logic in the existing retrieval domain module
- **Required Refactor Stories**: None anticipated

## Complexity Tracking

No constitution violations or justified complexity exceptions are required for
this feature.
