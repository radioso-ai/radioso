# Slice 4 Notes: Routine Drafting Assist

**Date**: 2026-06-12
**Branch**: `routine-text-composer`
**Scope**: `amendment-authoring-surface.md` §5 and §12 item 4 only.

## Delivered

- Added `POST /api/v1/agents/{agentId}/routines/draft-assist`.
- The endpoint accepts `{ prose }` and returns `{ draft, validation }`.
- The endpoint is authenticated and authorized with the existing agent manage surface.
- The endpoint never persists routine data, never saves, never publishes, and never returns or accepts a document AST.
- Added `backend/src/modules/routines/assist.ts`, which owns:
  - prompt loading
  - permitted-action catalog serialization
  - LLM call through the existing chat inference pipeline
  - JSON parsing and `RoutineDefinitionDraftInput` Zod validation
  - one retry on schema mismatch
  - transient routine validation through the existing validator
  - redacted logging/telemetry for success, provider error, schema mismatch, and invalid-after-retry
- Added prompt asset `backend/prompts/routines/draft-document.md`, modeled on the Coach draft-directive prompt structure.
- Registered the endpoint in code-first OpenAPI and regenerated:
  - `backend/openapi.yaml`
  - `backend/openapi.json`
  - `typescript-sdk/openapi/radioso.yaml`
  - `typescript-sdk/openapi/radioso.json`
  - `typescript-sdk/src/generated/types.ts`
  - `packages/radioso-mcp-server/src/generated/openapiTypes.ts`
- Added frontend API adapter `draftRoutineFromProcedure(agentId, { prose })`.
- Added a blank-new-routine outline affordance, "Draft from procedure", with a textarea, busy state, and review-before-save behavior.
- Extended dashboard fixtures and the routines Playwright spec with a mocked assist response. No live LLM is used in e2e.

## Architecture Notes

- v1 scope is initial drafting only. The UI exposes the drafting assist only while composing a new routine in the outline editor, not while editing an existing draft.
- Id-preserving edit-mode proposals are out of scope. Proposed stable ids are slugs derived from the proposed labels and are frozen by the existing save path.
- The LLM path is isolated to the authoring-assist module. Compile, document projection, outline projection, validation, save, and publish paths remain LLM-free.
- The route handler stays thin: it validates the request, passes workspace and agent ids to the service, and returns the service result.
- Composition wiring is limited to constructing the assist service from the existing chat inference pipeline, agent repository, logger, telemetry sink, and action handler registrations.
- The permitted-action catalog is built from registered action handlers. Proposed action/tool references outside that catalog are reported as validation diagnostics on the returned proposal; malformed JSON/schema output triggers the one retry before returning an author-facing 422.
- The prompt instructs the model to extract only steps, variables, branches, and ends from operator prose in any language; to treat the prose as untrusted input; and to propose actions only from the provided catalog.

## Review-Before-Apply Flow

The dashboard sends only the operator SOP prose to the assist endpoint. The returned `draft` is projected client-side into the outline editor using the slice-3 outline adapter. The operator can inspect and edit the proposed steps, branches, variables, and ends before using the existing save action. Nothing is saved by loading the proposal.

## Message-Queue Impact Review

No queue changes are needed. The assist endpoint is synchronous request/response, creates no routine definition rows, dispatches no document worker jobs, and enqueues no routine-action execution payloads. Search found no document-worker dispatch, AMQP payload, retry, or queue-doc surface tied to `draft-assist` or `draft_routine`; existing action outbox references are routine execution paths, not authoring assist.

## Observability Review

The service records provider-call start/completion/failure with workspace id, agent id, attempt number, prose length, catalog size, status, and failure mode. It records schema-mismatch retry and invalid-after-retry as separate failure modes. It does not log SOP prose, prompts, completions, proposed draft JSON, document content, retrieved chunks, tokens, credentials, cookies, or connection strings.

## Validation Evidence

Red phase:

```bash
cd backend && pnpm vitest run tests/unit/routine-draft-assist.test.ts
```

Initial result: failed as expected because `RoutineDraftAssistService` did not exist yet.

Focused assist unit tests:

```bash
cd backend && pnpm vitest run tests/unit/routine-draft-assist.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

OpenAPI generation:

```bash
cd backend && node --import tsx ./scripts/generateOpenApi.ts
```

Result: passed.

OpenAPI contract:

```bash
cd backend && pnpm vitest run tests/contract/openapi.contract.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       6 passed (6)
```

Generated SDK and MCP artifacts:

```bash
cd typescript-sdk && pnpm run sync
cd packages/radioso-mcp-server && pnpm run sync:openapi
node scripts/check-api-contracts.mjs
```

Result: passed. The generator emitted `npm warn Unknown env config ...` warnings from nested tooling, but no `npm` command was run.

Focused backend assist plus OpenAPI checks:

```bash
cd backend && pnpm vitest run tests/unit/routine-draft-assist.test.ts tests/contract/openapi.contract.test.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       10 passed (10)
```

Routine authoring contract test attempt:

```bash
cd backend && pnpm vitest run tests/contract/agents.contract.test.ts
```

Result: failed before assertions because Supertest could not bind a socket in this sandbox:

```text
Error: listen EPERM: operation not permitted 0.0.0.0
TypeError: Cannot read properties of null (reading 'port')
```

Required backend unit command:

```bash
cd backend && pnpm run test:unit
```

Result: failed before Vitest because the backend script tried to rebuild package outputs and hit sandbox write restrictions on generated files in `packages/conversation-engine/dist`.

```text
TS5033: Could not write file .../packages/conversation-engine/dist/*.d.ts
TS5033: Could not write file .../packages/conversation-engine/dist/*.js
```

Package prebuild repair:

```bash
pnpm --dir packages/conversation-engine run build
pnpm --dir packages/conversation-defaults run build
pnpm --dir packages/radioso-mcp-server run build
```

Result: passed.

Direct backend unit attempt:

```bash
cd backend && pnpm vitest run tests/unit
```

Result: executed but failed on the known sandbox socket-bind class in HTTP-oriented unit files:

```text
Test Files  13 failed | 228 passed (241)
Tests       77 failed | 1646 passed (1723)
Errors      72 errors
```

Representative failures were `Error: listen EPERM: operation not permitted 0.0.0.0` and `TypeError: Cannot read properties of null (reading 'port')`.

Frontend unit suite:

```bash
cd frontend && pnpm test
```

Result:

```text
Test Files  64 passed (64)
Tests       364 passed (364)
```

Frontend lint:

```bash
cd frontend && pnpm run lint
```

Result: passed with no findings.

Diff whitespace check:

```bash
git diff --check
```

Result: passed.

## Review Notes

Senior-engineer delivery review covered the diff for slice boundaries, persistence risk, prompt/data leakage, action-catalog enforcement, route ordering, OpenAPI generation, SDK/MCP generated artifacts, frontend review-before-save behavior, and test coverage. No blocking findings remained after the validation and notes pass.

## Commit Status

No commit, push, or PR was created per EM instruction.

## Post-ship feedback round

Product-owner real-world draft-assist testing exposed two mechanical defects in `POST /agents/:agentId/routines/draft-assist`.

- Slot-reference drift: the service now normalizes declared slot references in parsed proposals before validation, rewriting declared-slot `{{key}}`, `{{ key }}`, and `@key` prose references to `{{slot.key}}` across step instructions, transition guard text, and terminal instructions. Unknown slot-like references are left untouched for validation/review.
- Unreachable terminal recovery: the prompt now explicitly requires at least one reachable terminal path and default complete transitions for unbranched final steps. Parsed proposals with validation diagnostics now receive at most one corrective `validation_retry` LLM attempt with author-facing diagnostics appended; the service returns the retry only when it has strictly fewer diagnostics, preserving the original on ties, and still returns draft plus validation if diagnostics remain.

Verification:

```bash
cd backend && pnpm vitest run tests/unit/routine-draft-assist.test.ts
```

Result: passed, 11 tests.

```bash
cd backend && pnpm run test:unit
```

Result: failed before Vitest during `packages/conversation-engine` prebuild because TypeScript could not overwrite existing generated files:

```text
TS5033: Could not write file '/Users/dm/conductor/workspaces/radioso/seattle/packages/conversation-engine/dist/clarification.d.ts': EPERM: operation not permitted, open '/Users/dm/conductor/workspaces/radioso/seattle/packages/conversation-engine/dist/clarification.d.ts'.
```

No sandbox socket EPERM occurred in this run.

Follow-up review fixes:

- Validation retry tie-break now biases toward the original parsed proposal. A corrective retry must be strictly better by diagnostic count to replace it. Future refinement: diagnostic severity/category weighting could make "better" more nuanced than count-only, but that was intentionally left out of this patch.
- Slot-reference normalization now participates in schema parsing. The parser normalizes declared slot references, then re-runs `routineDefinitionDraftInputSchema.safeParse`; if normalization pushes a prose field past its schema limit, that attempt is treated as the existing `schema_mismatch` and flows through the existing schema retry/error path.
- Timeout verification for the worst-case 3 serial LLM calls: `POST /agents/:agentId/routines/draft-assist` has no route-specific timeout; `startApiRuntime` uses `app.listen`, so the effective Node HTTP defaults are `requestTimeout=300000ms`, `headersTimeout=60000ms`, `timeout=0`, and `keepAliveTimeout=5000ms`. The frontend `routinesApi.draftRoutineFromProcedure` uses the normal `request()` wrapper with browser `fetch` and no AbortController timeout. The current OpenAI/Gemini text-generation clients do not apply the embedding timeout helper to chat completions. No limit change was made because the server request budget is 300s and there is no shorter frontend timeout for this call.

Follow-up verification:

```bash
cd backend && pnpm vitest run tests/unit/routine-draft-assist.test.ts
```

Result: passed, 14 tests.

```bash
cd backend && pnpm run test:unit
```

Result: failed before Vitest during `packages/conversation-engine` prebuild with generated-file write EPERMs:

```text
TS5033: Could not write file '/Users/dm/conductor/workspaces/radioso/seattle/packages/conversation-engine/dist/clarification.d.ts': EPERM: operation not permitted, open '/Users/dm/conductor/workspaces/radioso/seattle/packages/conversation-engine/dist/clarification.d.ts'.
TS5033: Could not write file '/Users/dm/conductor/workspaces/radioso/seattle/packages/conversation-engine/dist/clarification.js': EPERM: operation not permitted, open '/Users/dm/conductor/workspaces/radioso/seattle/packages/conversation-engine/dist/clarification.js'.
```

No sandbox socket EPERM occurred in this follow-up run.
