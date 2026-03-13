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
- 004-strict-grounding: Added TypeScript 5.x on Node.js 22 + Express, pg, OpenAI SDK, Zod, Pino, Vitest, Supertes
- 003-chat-route-citations: Added TypeScript 5.x on Node.js 22 for the backend, TypeScript 5.7 with React 19 and Next.js 16 for the frontend + Next.js App Router, React 19, Radix UI primitives, Express, Zod, browser Fetch and ReadableStream APIs
>>>>>>> main
- 002-improve-rag-pipeline: Added TypeScript 5.x on Node.js 22 + Express, OpenAI SDK, `pg`, `pgvector`, Zod, Pino
- 001-rag-api-backend: Added TypeScript 5.x on Node.js 22 + Express, `pg`, OpenAI SDK, Zod, Pino, a recursive text splitter package, cookie parsing/session utilities, password hashing library, Vitest, Supertes
