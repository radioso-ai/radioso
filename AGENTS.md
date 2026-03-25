# radioso Development Guidelines

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
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, OpenAI SDK, pg, Zod, Pino, Vitest, Supertest, Next.js App Router, existing chat streaming route (010-precise-citations)
- PostgreSQL unchanged; no new persisted data for this feature (010-precise-citations)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, pg, OpenAI SDK, Zod, Vitest, Supertest, Next.js App Router (012-async-document-processing)
- PostgreSQL 16+ with `pgvector`; additive job/revision columns and processing-job table (012-async-document-processing)
- TypeScript (Node.js backend, Next.js frontend) + Express, Next.js 14, React, shadcn/ui, Zod, pg (node-postgres), OpenAI SDK (014-multi-workspace)
- PostgreSQL 16 with pgvector extension (014-multi-workspace)
- TypeScript / Node.js 22 + Express, Zod, pg (node-postgres) (015-document-metadata)
- PostgreSQL 16 with pgvector — JSONB columns with GIN indexes (015-document-metadata)
- Node.js (TypeScript) backend, React (TypeScript) frontend + Express, Zod (validation), React, Tailwind CSS, shadcn/ui components (016-workspace-mgmt)
- PostgreSQL with `pgvector` — workspaces table already has ON DELETE CASCADE on all child FK references (016-workspace-mgmt)
- TypeScript / Node.js (backend), TypeScript / React + Next.js (frontend) + Express.js, pg (PostgreSQL driver), Vitest (testing), Shadcn/ui (frontend components) (016-chat-connectors)
- PostgreSQL with `pgvector` extension (016-chat-connectors)
- HCL (Terraform >= 1.5) + `hashicorp/google` provider (~> 5.x), `hashicorp/google-beta` provider (~> 5.x) (018-terraform-gcp-deploy)
- GCS bucket for Terraform remote state; Cloud SQL PostgreSQL 16 for application data (018-terraform-gcp-deploy)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 + React 19 + Next.js 16 (frontend), ESM local package under `/packages` + Express, Zod, `pg`, Vitest, Supertest, `@google-cloud/storage`, route-scoped multipart parsing, and file-format parsers for PDF, DOCX, TXT, and XLSX (020-document-import-gcs)
- PostgreSQL 16 for document metadata and extracted text; GCP Cloud Storage bucket for original uploaded files (020-document-import-gcs)
- TypeScript (Node.js backend, Next.js 16 / React 19 frontend) + Express, Next.js App Router, Shadcn/Radix UI, Tailwind CSS (020-anon-chat-access)
- PostgreSQL with `pgvector` (existing) (020-anon-chat-access)
- TypeScript 5.x on Node.js 22 + Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertes (021-retrieval-stages)
- PostgreSQL 16 with `pgvector` (unchanged) (021-retrieval-stages)
- TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend + Express, Zod, `pg`, OpenAI SDK, Pino, Next.js App Router, Radix UI, Vitest, Supertes (024-ingestion-settings)
- PostgreSQL 16 with `pgvector`; additive workspace-scoped ingestion settings storage and existing document-processing tables (024-ingestion-settings)
- Node.js 22 ESM script for the default bootstrap entry point, plus existing Bash wrapper compatibility; existing TypeScript backend/frontend remain unchanged + Node built-ins (`fs`, `path`, `child_process`, `readline`, `crypto`), Docker CLI with `docker compose`, existing Compose files under `infra/`, backend `.env.example` contract, Node test runner for bootstrap coverage (025-terminal-bootstrap)
- Local filesystem for `backend/.env`; existing Docker-managed PostgreSQL volume via Compose (025-terminal-bootstrap)
- TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend + Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest, Next.js App Router, existing Radix/shadcn UI primitives, React Flow for the trace graph UI (025-retrieval-trace-graph)
- PostgreSQL 16 with `pgvector`; reuse existing audit-event metadata for persisted trace replay, no new storage system planned (025-retrieval-trace-graph)
- PostgreSQL 16 with `pgvector`; reuse `audit_events.metadata_json` for replayable search history snapshots and traces, no new storage system planned (026-document-search)
- TypeScript 5.7 on Node.js 22, React 19, Next.js 16 + `react-markdown`, `remark-breaks`, existing Radix UI primitives, Lucide icons (027-markdown-chat)
- N/A; presentation-only feature with no new persistence (027-markdown-chat)


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
- 027-markdown-chat: Added TypeScript 5.7 on Node.js 22, React 19, Next.js 16 + `react-markdown`, `remark-breaks`, existing Radix UI primitives, Lucide icons
- 026-document-search: Added TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend + Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest, Next.js App Router, existing Radix/shadcn UI primitives
- 025-terminal-bootstrap: Added Node.js 22 ESM script for the default bootstrap entry point, plus existing Bash wrapper compatibility; existing TypeScript backend/frontend remain unchanged + Node built-ins (`fs`, `path`, `child_process`, `readline`, `crypto`), Docker CLI with `docker compose`, existing Compose files under `infra/`, backend `.env.example` contract, Node test runner for bootstrap coverage
