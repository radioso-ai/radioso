# Implementation Plan: Chat Streaming Hotfix

**Branch**: `codex/005-chat-streaming-hotfix` | **Date**: 2026-03-14 | **Spec**: [/tmp/radioso-chat-streaming-hotfix/specs/005-chat-streaming-hotfix/spec.md](/tmp/radioso-chat-streaming-hotfix/specs/005-chat-streaming-hotfix/spec.md)
**Input**: Feature specification from `/tmp/radioso-chat-streaming-hotfix/specs/005-chat-streaming-hotfix/spec.md`

## Summary

Replace the fake SSE replay path with a real streaming orchestration flow. The route and presenter will stay transport-only, `ChatService` will gain a streaming lifecycle that persists conversation state after successful completion, and `OpenAIChatGateway` will translate provider stream events into plain text deltas.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22  
**Primary Dependencies**: Express, OpenAI SDK 5.x, Zod, Vitest, Supertest  
**Storage**: PostgreSQL repositories in production, in-memory fakes in tests  
**Testing**: Backend unit and contract tests with TDD, plus targeted TypeScript build validation via `npm test` in `backend/`  
**Target Platform**: Express API consumed by the existing Next.js frontend  
**Constraints**: Preserve non-streaming response contract, keep presenter transport-only, keep gateway provider-specific, avoid persisting partial assistant responses on failure  
**Scale/Scope**: Hotfix limited to chat streaming transport and its tests

## Constitution Check

*GATE: Must pass before implementation. Re-check after design.*

- Approved spec exists before implementation. PASS
- Backend changes follow TDD with failing tests first. PASS
- Stack remains Node.js backend and existing OpenAI integration. PASS
- Secrets/config hygiene unchanged. PASS
- Modular boundaries remain explicit across route, service, and gateway layers. PASS

## Project Structure

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── presenters/
│   │   └── routes/
│   └── modules/chat/services/
└── tests/
    ├── contract/
    ├── support/
    └── unit/
```

## Module Ownership & Seams

- `backend/src/app/http/routes/chatRoutes.ts`: chooses JSON vs streaming service path; no provider logic
- `backend/src/app/http/presenters/chatPresenter.ts`: formats SSE events and response headers only
- `backend/src/modules/chat/services/chatService.ts`: owns conversation loading, retrieval, persistence, audit, and stream completion lifecycle
- `backend/tests/support/testApp.ts`: provides configurable fake gateways for contract tests

## Complexity Tracking

No constitution violations expected.
