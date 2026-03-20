# Quickstart: Inference-Based Fallback Answers

## Prerequisites

- PostgreSQL running with the retrieval_settings table
- Backend and frontend dev servers running
- At least one workspace with some (but not comprehensive) documents uploaded

## Implementation Order

1. **Database migration** — Add `inference_answer_enabled` column
2. **Domain + repository** — Add field to settings interfaces, defaults, validation, and DB mapping
3. **API route** — Add to Zod schema
4. **Prompt builder** — Add `buildInferencePrompt` method
5. **Chat service** — Branch on zero-contexts + setting, call inference prompt
6. **Chat presenter** — Add `source` field to response payloads
7. **Frontend types** — Add field to `RetrievalSettings` and chat response types
8. **Frontend UI** — Add toggle to settings, add inference indicator to chat

## Testing the Feature

1. Open retrieval settings → verify "Inference Fallback" toggle exists and is off
2. Enable the toggle → save → reload → verify it persists
3. Ask a question that has no matching documents (e.g., "What is the capital of France?")
   - With toggle **off**: should see "I could not find relevant information in your documents."
   - With toggle **on**: should see an LLM-generated answer with inference indicator
4. Verify no `[[n]]` citations appear in inference answers
5. Verify retrieval diagnostics still show zero contexts in the response

## Key Files

| Layer | File | Change |
|-------|------|--------|
| Domain | `backend/src/modules/settings/domain/retrievalSettings.ts` | New field |
| Persistence | `backend/src/db/repositories/retrievalSettingsRepository.ts` | Column mapping |
| Transport | `backend/src/app/http/routes/settingsRoutes.ts` | Zod schema |
| Transport | `backend/src/app/http/presenters/chatPresenter.ts` | Response format |
| Orchestration | `backend/src/modules/chat/services/chatService.ts` | Branching logic |
| Domain | `backend/src/modules/retrieval/services/promptBuilder.ts` | Inference prompt |
| Frontend | `frontend/lib/api.ts` | Type definitions |
| Frontend | `frontend/components/dashboard/settings-view.tsx` | Toggle + indicator |
