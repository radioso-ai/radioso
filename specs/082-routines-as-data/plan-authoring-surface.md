# Implementation Plan: 082 Amendment Authoring Surface Slices 1-2

**Branch**: `routine-text-composer` | **Spec**: `specs/082-routines-as-data/amendment-authoring-surface.md`
**Scope**: §12 item 1 delivered; §12 item 2 adds the two FR-018 schema cuts plus the counter-exhausted default-edge runtime golden test.

## Summary

Slice 1 added the pure backend document-model core for the routine authoring surface. The document AST is the product artifact; fixture text is an engineer-facing serialization used for tests, traces, and debugging. It implements typed document sections with the routine/steps section active and guidelines/glossary parsed as recognized no-op placeholders. It projects losslessly between `RoutineDefinitionDraftInput` and the document AST, serializes/parses fixture notation, builds a stable-id source map, and covers round-trip identity and diagnostics with golden tests.

Slice 2 performs only the FR-018 schema cuts:

- Delete authored step kind `fork` end-to-end. Existing behavior parity is preserved because `fork` was never exposed by the UI and compiled as `chat`; new validation/contracts reject it.
- Merge authored transition guard kinds `always` and `fallback` into one stored default/unconditioned edge representation: `guardKind: "default"` in routine-definition data and a compiled `RoutineGuard` of `{ kind: "default" }`. Runtime behavior is derived from sibling context: a default edge with no conditioned siblings behaves like old `always`; a default edge with conditioned/LLM siblings is the last-resort fallback. Database migration `089` converts existing routine-definition rows from `always`/`fallback` to `default` in place and makes the check constraints startup-safe without dropping tables or touching `routine_states`.

Out of scope for slice 2: UI, prompt assets, new endpoints, AMQP changes, export/import, and the later outline editor/drafting assist.

## Technical Context

- Backend TypeScript on Node.js 24.
- Existing owner module: `backend/src/modules/routines/`.
- New authoring document module: `backend/src/modules/routines/document/`.
- Existing draft type: `RoutineDefinitionDraftInput` from `backend/src/modules/routines/domain.ts`.
- Existing validator diagnostics use `location` strings such as `step:<id>`, `transition:<from>-><to>`, `slot:<key>`, and `routine:<name>`.
- Engine contract owner: `packages/conversation-contract/index.d.ts`; pure engine behavior owner: `packages/conversation-engine/src/routineRunner.ts`.
- Code-first OpenAPI owner in this branch: `backend/src/app/http/openapi/schemas/agentSchemas.ts`, which imports the Zod routine definition schema from `backend/src/modules/routines/domain.ts`; generated artifacts are `backend/openapi.yaml`, `backend/openapi.json`, `typescript-sdk/openapi/radioso.{yaml,json}`, `typescript-sdk/src/generated/types.ts`, and `packages/radioso-mcp-server/src/generated/openapiTypes.ts`.
- Latest migration on branch and `origin/main` is `088_clarification_states.sql`; slice 2 migration is `089_routine_default_guard_schema_cut.sql`.
- Tests: Vitest unit tests under `backend/tests/unit/`.

## Constitution Check

- **Spec-first**: approved parent spec exists; this plan implements the amendment only.
- **Backend TDD**: write failing schema-cut parity and runtime golden tests before implementation.
- **Stack discipline**: backend-only TypeScript; no new runtime dependency.
- **No keyword lists**: parser keywords are fixture grammar (`Variables`, `Steps`, `Ends`, `Guidelines`, `Glossary`) allowed by SC-014. No product behavior is inferred from English prose.
- **Modularity**: document model and transforms live with the authoring module. Pure engine packages must not import it, and it must not import engine packages.
- **Composition**: no app-wide adapter, registry, lifecycle, storage, or dispatcher changes; no `backend/src/app/composition/` updates.
- **Contracts and queues**: slice 2 changes public authoring enum contracts, so update the code-first OpenAPI registry and regenerate backend OpenAPI, SDK, and MCP generated types. Message-queue impact review: no document worker dispatch, AMQP queue payload, retry semantics, queue tests, or queue docs change is expected because neither routine step kinds nor routine guard kinds are carried by worker queue payloads; verify by search and record evidence in `slice-doc2-notes.md`.
- **Docs parity**: update docs and spec artifacts that enumerate routine step/guard kinds, including the engineer-facing fixture notation and parent spec/plan references. Follow `docs/document-writer-prompt.md` before editing product docs.
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

### Slice 2 Runtime And Contract Design

- `backend/src/modules/routines/domain.ts` owns the authoring enum cut: `routineStepKinds = ["chat", "tool", "action"]`; `routineGuardKinds = ["llm", "default", "slot_filled", "outcome", "counter"]`.
- Repository loading accepts legacy persisted `always`/`fallback` defensively and normalizes them to `default`, preserving local databases that have not yet run migration `089`.
- `compileRoutineDefinition` emits `{ kind: "default" }` for default edges and leaves `condition` as `"default"` for trace/debug continuity. `llm` remains selector-driven.
- `DefaultRoutineRunner` treats a default guard as deterministic only when there are no conditioned/LLM sibling transitions. When conditioned siblings exist, it uses the default edge after deterministic guards fail and after LLM selection declines or is unavailable. This preserves old `always` and `fallback` behavior without exposing two stored guard names.
- `counter` exhaustion continues to force the default edge from the same source step; the golden test pins this before and after the merge.

## Fixture Decisions Finalized

- **Counter × outcome**: the fixture parser rejects combined guard markers on one edge (`if` prose, `[status]`/`[needs ...]`, and `↺N` are mutually exclusive) because the current draft model has one `guardKind` per transition. Slice 2 pins the runtime rule that a counter permits the bounded retry while under the limit and forces the `default` edge once exhausted.
- **Nested sub-step notation**: nested conversational beats are represented as explicit anchored steps in fixture text. Indented prose under a branch without a target is rejected with the token-less-beat diagnostic instead of being silently promoted. The §8.4 worked example is flattened into anchored steps while preserving the stable ids and branch relationships.

## Validation Plan

- Focused tests: `cd backend && pnpm test -- tests/unit/routine-document-roundtrip.test.ts`
- Runtime golden tests: `pnpm --dir packages/conversation-engine test -- tests/defaultRoutineRunner.test.ts`
- Routine definition tests: `cd backend && pnpm vitest run tests/unit/routine-definition-service.test.ts tests/unit/routine-document-roundtrip.test.ts`
- Contract generation: use the repo's existing OpenAPI/SDK/MCP generation scripts, then inspect generated diffs rather than hand-editing artifacts.
- Broad backend unit suite: `cd backend && pnpm run test:unit`
- Architecture sanity: verify no imports from `packages/conversation-engine` or `packages/conversation-contract` were added by the document module.
