# Implementation Plan: Inference-Based Fallback Answers

**Branch**: `020-inference-fallback` | **Date**: 2026-03-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/020-inference-fallback/spec.md`

## Summary

When the retrieval pipeline returns zero document contexts, the system currently returns a static dead-end message. This feature adds a workspace-level toggle (`inferenceAnswerEnabled`, default off) that, when enabled, calls the LLM with a context-free prompt to generate a general-knowledge answer. Responses are tagged with `source: "inference"` so the frontend can visually distinguish them from document-grounded answers.

## Technical Context

**Language/Version**: TypeScript (Node.js backend, React/Next.js frontend)
**Primary Dependencies**: Express.js, OpenAI SDK, shadcn/ui (Switch component), Zod
**Storage**: PostgreSQL (new boolean column `inference_answer_enabled` on retrieval_settings table)
**Testing**: Jest (TDD per constitution — tests first, then implementation)
**Target Platform**: Web application (server + browser)
**Project Type**: Web (backend + frontend)
**Performance Goals**: Inference answers must stream with the same perceived latency as retrieval answers
**Constraints**: No new services or modules; changes contained within existing layers
**Scale/Scope**: ~8 files modified, 0 new files (excluding tests and migration)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] Spec exists and is approved; no implementation without spec.
- [x] Backend work includes TDD with failing tests written before implementation.
- [x] Stack remains Node.js for backend and React for frontend.
- [x] Database is PostgreSQL with `pgvector` for embeddings and vector search.
- [x] LLM provider is GPT-5.2 for AI integrations.
- [x] Secrets and keys are managed via `.env` and `.env.example` is updated. *(No new secrets needed.)*
- [x] Customer data handling and auditability are addressed where applicable. *(Inference answers are logged via existing audit trail; no new data collection.)*
- [x] Module boundaries between transport, orchestration, domain logic, and persistence are explicit.
- [x] Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects.
- [x] No required refactor stories — all target files are well-scoped and can absorb minimal additions.

## Project Structure

### Documentation (this feature)

```text
specs/020-inference-fallback/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── modules/
│   │   ├── settings/
│   │   │   └── domain/retrievalSettings.ts        # Add inferenceAnswerEnabled field + validation
│   │   ├── chat/
│   │   │   └── services/chatService.ts            # Branch on zero-contexts + setting
│   │   └── retrieval/
│   │       └── services/promptBuilder.ts          # New inference prompt method
│   ├── app/
│   │   └── http/
│   │       ├── routes/settingsRoutes.ts           # Add to Zod schema
│   │       └── presenters/chatPresenter.ts        # Add source field to response
│   └── db/
│       └── repositories/
│           └── retrievalSettingsRepository.ts     # Add column mapping
├── migrations/
│   └── XXX_add_inference_answer_enabled.sql       # New migration
└── tests/                                         # TDD tests

frontend/
├── components/
│   └── dashboard/settings-view.tsx                # Add toggle to retrieval tab
└── lib/api.ts                                     # Add field to type
```

**Structure Decision**: Web application structure. All changes slot into existing modules. No new modules or services.

## Module Ownership & Seams

- **Transport Layer**: `settingsRoutes.ts` (validates + routes settings API), `chatPresenter.ts` (formats chat responses including new `source` field)
- **Orchestration Layer**: `chatService.ts` (branches on zero-contexts + `inferenceAnswerEnabled`, delegates to `promptBuilder` for inference prompt)
- **Domain Layer**: `retrievalSettings.ts` (owns the `inferenceAnswerEnabled` field definition, defaults, and validation), `promptBuilder.ts` (owns the inference prompt variant)
- **Persistence/Integration Layer**: `retrievalSettingsRepository.ts` (maps DB column), migration (adds column)
- **Files Kept Small**: `chatService.ts` — only adds a conditional branch at the existing zero-contexts check; does NOT embed prompt text. `retrievalPipelineService.ts` — untouched, remains unaware of inference fallback.
- **Planned Extractions**: None needed. `promptBuilder.ts` gets one new method (`buildInferencePrompt`) alongside the existing `build` method.
- **Required Refactor Stories**: None. All target files are well-scoped.

## Detailed Changes Per File

### 1. `backend/src/modules/settings/domain/retrievalSettings.ts`

- Add `inferenceAnswerEnabled: boolean` to `RetrievalSettingsRecord` and `RetrievalSettingsInput` interfaces
- Add default: `inferenceAnswerEnabled: false` to `defaultRetrievalSettings()`
- Add boolean type check in `validateRetrievalSettings()`

### 2. `backend/src/modules/chat/services/chatService.ts`

**Streaming path** (around line 185): Replace the `contexts.length === 0` branch:
```
if contexts.length === 0 AND inferenceAnswerEnabled:
  build inference prompt via promptBuilder.buildInferencePrompt(...)
  call chatGateway.streamAnswer(...) with inference prompt
  tag response with source: "inference"
else if contexts.length === 0:
  return static message (existing behavior)
  tag response with source: "retrieval" (or omit, for backward compat)
else:
  existing retrieval flow
  tag response with source: "retrieval"
```

**Non-streaming path** (around line 293): Same branching logic.

The setting must be fetched — `chatService` already has access to retrieval settings via the session or settings service.

### 3. `backend/src/modules/retrieval/services/promptBuilder.ts`

Add a new method `buildInferencePrompt(params)`:
- Includes system instruction: "You are a helpful assistant."
- Includes warmth instruction (reuse `getWarmthInstruction`)
- Includes custom instruction (reuse `renderCustomInstruction`)
- Includes instruction: "No relevant documents were found for this query. Answer from your general knowledge if appropriate. Clearly indicate that your answer is not based on the user's documents. Do not use citation markers like [[n]]."
- Includes conversation history (reuse existing pattern)
- Includes user question
- **Omits**: Retrieved Context section, citation formatting rules

### 4. `backend/src/app/http/routes/settingsRoutes.ts`

Add `inferenceAnswerEnabled: z.boolean()` to the `updateSettingsSchema` object.

### 5. `backend/src/app/http/presenters/chatPresenter.ts`

Add `source: "retrieval" | "inference"` to both `sendChatJson` and `sendChatSse` (in the `done` event) payloads.

### 6. `backend/src/db/repositories/retrievalSettingsRepository.ts`

- Add `inference_answer_enabled` to SELECT, INSERT, UPDATE column lists
- Add mapping in `mapSettings`: `inferenceAnswerEnabled: row.inference_answer_enabled`
- Add parameter to upsert method

### 7. Database migration

```sql
ALTER TABLE retrieval_settings
ADD COLUMN inference_answer_enabled BOOLEAN NOT NULL DEFAULT FALSE;
```

### 8. `frontend/lib/api.ts`

Add `inferenceAnswerEnabled: boolean` to `RetrievalSettings` interface.
Add `source?: 'retrieval' | 'inference'` to the chat response type.

### 9. `frontend/components/dashboard/settings-view.tsx`

Add an "Inference Fallback" toggle in the "Response Style" section (near `citationDisplayEnabled`):
- Label: "Inference Fallback"
- Description: "When no documents match, answer from general knowledge instead of showing a no-results message"
- Uses `Switch` component, same pattern as existing toggles

Add visual indicator in chat message rendering for `source === "inference"` responses:
- Subtle banner/label: "Answered from general knowledge — not based on your documents"
- Hide citation UI when source is "inference"

## Complexity Tracking

No constitution violations. No complexity justifications needed.
