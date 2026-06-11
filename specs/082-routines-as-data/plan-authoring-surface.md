# Implementation Plan: 082 Amendment Authoring Surface Slice 1

**Branch**: `routine-text-composer` | **Spec**: `specs/082-routines-as-data/amendment-authoring-surface.md`
**Scope**: §12 item 1 only: document model, `RoutineDefinitionDraft` projection, fixture parser/serializer, source map, and golden tests.

## Summary

Add the pure backend document-model core for the routine authoring surface. The document AST is the product artifact; fixture text is an engineer-facing serialization used for tests, traces, and debugging. This slice implements typed document sections with the routine/steps section active and guidelines/glossary parsed as recognized no-op placeholders. It projects losslessly between `RoutineDefinitionDraftInput` and the document AST, serializes/parses fixture notation, builds a stable-id source map, and covers round-trip identity and diagnostics with golden tests.

Out of scope: UI, schema changes, migrations, prompt assets, API endpoints, OpenAPI/SDK/MCP changes, runtime guard enum changes, and the always/fallback merge.

## Technical Context

- Backend TypeScript on Node.js 24.
- Existing owner module: `backend/src/modules/routines/`.
- New authoring document module: `backend/src/modules/routines/document/`.
- Existing draft type: `RoutineDefinitionDraftInput` from `backend/src/modules/routines/domain.ts`.
- Existing validator diagnostics use `location` strings such as `step:<id>`, `transition:<from>-><to>`, `slot:<key>`, and `routine:<name>`.
- Tests: Vitest unit tests under `backend/tests/unit/`.

## Constitution Check

- **Spec-first**: approved parent spec exists; this plan implements the amendment only.
- **Backend TDD**: write failing golden round-trip, branch-vs-nuance, and diagnostic/source-map tests before implementation.
- **Stack discipline**: backend-only TypeScript; no new runtime dependency.
- **No keyword lists**: parser keywords are fixture grammar (`Variables`, `Steps`, `Ends`, `Guidelines`, `Glossary`) allowed by SC-014. No product behavior is inferred from English prose.
- **Modularity**: document model and transforms live with the authoring module. Pure engine packages must not import it, and it must not import engine packages.
- **Composition**: no app-wide adapter, registry, lifecycle, storage, or dispatcher changes; no `backend/src/app/composition/` updates.
- **Contracts and queues**: no public API, SDK, MCP, connector, worker payload, AMQP, or queue semantics changes.
- **Docs parity**: user-facing docs are slice 5. Slice 1 records design/validation evidence in `slice-doc1-notes.md`.
- **Observability**: no new runtime path, worker job, queue handoff, provider call, retry, fallback, or operator-visible latency. No logs/metrics/spans needed.

## Module Design

### What Each File Knows

- `backend/src/modules/routines/document/model.ts`
  - Knows the typed document AST, reference token taxonomy, fixture source positions, and source-map shape.
  - Does not know persistence, HTTP, UI, or conversation-engine runtime types.
- `backend/src/modules/routines/document/transform.ts`
  - Knows how to project `RoutineDefinitionDraftInput` to/from the document AST.
  - Infers routine draft fields from structural tokens and branch rows only.
  - Does not validate publishability beyond transform-local document diagnostics.
- `backend/src/modules/routines/document/fixture.ts`
  - Knows the engineer-facing fixture grammar and parser/serializer.
  - Does not own product semantics or author-facing UI behavior.
- `backend/src/modules/routines/document/index.ts`
  - Exposes the narrow public port for tests and future UI/API slices.

### Ports

- `routineDraftToDocument(draft): RoutineDocument`
- `routineDocumentToDraft(document): { draft, diagnostics, sourceMap }`
- `serializeRoutineDocument(document): string`
- `parseRoutineDocumentFixture(text): { document, diagnostics, sourceMap }`
- `mapRoutineDiagnosticToDocumentRange(diagnostic, sourceMap): DocumentTextRange | null`

### Dependency Direction

`routines/document` may import the existing routines domain type. Existing routines public exports may re-export the document port. Engine and contract packages remain independent and receive only compiled `Routine` graphs through existing paths.

## Fixture Decisions Finalized

- **Counter × outcome**: the fixture parser rejects combined guard markers on one edge (`if` prose, `[status]`/`[needs ...]`, and `↺N` are mutually exclusive) because the current draft model has one `guardKind` per transition. Runtime counter-exhaustion semantics remain unchanged and are not implemented in this slice.
- **Nested sub-step notation**: nested conversational beats are represented as explicit anchored steps in fixture text. Indented prose under a branch without a target is rejected with the token-less-beat diagnostic instead of being silently promoted. The §8.4 worked example is flattened into anchored steps while preserving the stable ids and branch relationships.

## Validation Plan

- Focused tests: `cd backend && pnpm test -- tests/unit/routine-document-roundtrip.test.ts`
- Broad backend unit suite: `cd backend && pnpm run test:unit`
- Architecture sanity: verify no imports from `packages/conversation-engine` or `packages/conversation-contract` were added by the document module.

