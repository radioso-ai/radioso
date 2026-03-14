# hivec Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-17

## Active Technologies
- TypeScript on Node.js 22 (backend), React 19 + Next.js 15 (frontend) + Express, pg, Playwright, OpenAI SDK (GPT-5.2 + embeddings), Next.js , LangChain
- TypeScript 5.x on Node.js 22 + Express, `pg`, OpenAI SDK, Zod, Pino, a recursive text splitter package, cookie parsing/session utilities, password hashing library, Vitest, Supertes (001-rag-api-backend)
- PostgreSQL 16+ with `pgvector`; filesystem only for local docs such as OpenAPI YAML (001-rag-api-backend)
- TypeScript 5.x on Node.js 22 + Express, OpenAI SDK, `pg`, `pgvector`, Zod, Pino (002-improve-rag-pipeline)
- PostgreSQL 16+ with `pgvector`; filesystem-backed feature artifacts under `/specs/002-improve-rag-pipeline/` (002-improve-rag-pipeline)
- TypeScript 5.x on Node.js 22 + Express, pg, OpenAI SDK, Zod, Pino, Vitest, Supertes (004-strict-grounding)
- PostgreSQL 16+ with `pgvector`; filesystem-backed Speckit artifacts (004-strict-grounding)
- TypeScript 5.x on Node.js 22 for the backend, TypeScript 5.7 with React 19 and Next.js 16 for the frontend + Next.js App Router, React 19, Radix UI primitives, Express, Zod, browser Fetch and ReadableStream APIs (003-chat-route-citations)
- Browser `localStorage` for authenticated user bootstrap, in-memory client state for active chat session, backend account-scoped document and chat APIs, PostgreSQL unchanged (003-chat-route-citations)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI Slider/Hover Card (006-chat-response-controls)
- PostgreSQL account-scoped settings in `retrieval_settings`; existing chat response payloads and SSE events (006-chat-response-controls)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI primitives, Lucide icons (008-document-list-polish)
- PostgreSQL 16+ (`documents`, `chunks` with `ON DELETE CASCADE`), no new storage systems (008-document-list-polish)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI primitives, existing audit service, PostgreSQL full-text search functions, existing embedding and rerank services (009-hybrid-retrieval)
- PostgreSQL `chunks`, `retrieval_settings`, `documents`, `messages`, and `audit_events`; additive chunk-search and retrieval-settings columns only, no new external storage system (009-hybrid-retrieval)


## Project Structure

```text
backend/
frontend/
tests/
```

## Commands

# Add commands for 

## Code Style

: Follow standard conventions

## Recent Changes
- 009-hybrid-retrieval: Added TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI primitives, existing audit service, PostgreSQL full-text search functions, existing embedding and rerank services
- 008-document-list-polish: Added TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI primitives, Lucide icons
- 006-chat-response-controls: Added TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI Slider/Hover Card
>>>>>>> main
