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
- PostgreSQL 16 with `pgvector` unchanged; additive audit-event metadata only, no schema change planned (026-answer-support-validator)
- PostgreSQL 16 with `pgvector`; reuse `audit_events.metadata_json` for replayable search history snapshots and traces, no new storage system planned (026-document-search)
- TypeScript 5.7 on Node.js 22, React 19, Next.js 16 + `react-markdown`, `remark-breaks`, existing Radix UI primitives, Lucide icons (027-markdown-chat)
- N/A; presentation-only feature with no new persistence (027-markdown-chat)
- TypeScript 5.x on Node.js 22 + Express, `pg`, Zod, Pino, Vitest, Supertest, local connector packages (029-split-document-worker)
- PostgreSQL 16 with `pgvector`, existing `document_processing_jobs`, existing connector config persistence (029-split-document-worker)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 + React 19 + Next.js 16 (frontend) + Express, pg, Zod, OpenAI SDK, Next.js App Router, Radix/shadcn UI, existing local parser package under `/packages` (031-security-remediation)
- PostgreSQL 16 with `pgvector`; additive durable abuse-control persistence; existing sessions, workspace tokens, and connector config records (031-security-remediation)
- TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend + Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, Radix UI primitives (032-split-rewrite-queries)
- PostgreSQL 16 with `pgvector`; additive retrieval-settings persistence for semantic and lexical rewrite instruction fields (032-split-rewrite-queries)
- PostgreSQL 16 with `pgvector`; additive retrieval-settings persistence for the workspace answer-support policy (034-answer-support-policy)
- TypeScript 5.7 on Node.js 22 for the frontend application + React 19, Next.js 16 App Router, Radix UI primitives, Lucide icons (033-dashboard-deep-links)
- Browser URL state plus existing browser local storage for workspace bootstrap (033-dashboard-deep-links)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, Zod, `pg`, Pino, Vitest, Supertest, Next.js App Router, Radix UI primitives, Lucide icons (036-account-users)
- PostgreSQL 16 with additive `users`, `account_memberships`, and `account_invitations` tables; existing `accounts`, `workspaces`, `sessions`, and `workspace_tokens` remain in use (036-account-users)
- PostgreSQL 16 with `pgvector`; additive `documents.external_document_id` persistence with workspace-scoped uniqueness (037-external-document-id)
- Node.js 22 ESM scripts for the benchmark harness, plus existing TypeScript 5.x backend and TypeScript 5.7 frontend + existing Node.js toolchain, `pg`, Docker Compose, benchmark-harness dependencies for HTTP load generation and result formatting, existing backend/frontend package scripts (037-performance-benchmarking)
- PostgreSQL 16 for app state under test; filesystem-backed benchmark definitions in the repo and gitignored run artifacts under `.context/performance-runs/` (037-performance-benchmarking)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 + React 19 + Next.js 16 (frontend) + Express, `pg`, Zod, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router (039-assistant-bootstrap)
- PostgreSQL 16 with additive workspace-scoped columns on `workspaces`; existing conversations/messages tables (039-assistant-bootstrap)
- TypeScript 5.x on Node.js 22 + Express, Zod, pg, OpenAI SDK, Pino, Vitest, Supertes (039-unsupported-answer-refine)
- PostgreSQL 16 with `pgvector`; no schema changes planned (039-unsupported-answer-refine)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, Zod, `pg`, Pino, Next.js App Router, existing Radix/shadcn UI primitives, existing chat/public-chat frontend utilities (040-website-embed-widget)
- PostgreSQL 16 with additive workspace columns; existing conversations/messages/audit events reused (040-website-embed-widget)
- TypeScript 5.x on Node.js 22 + Express, `pg`, Zod, Pino, Vitest, Supertest, `@google-cloud/tasks`, existing local connector/document packages (042-autoscale-workers)
- PostgreSQL 16 with `pgvector`; existing `document_processing_jobs`, `documents`, `chunks`, and audit events; Google Cloud Tasks for delivery only (042-autoscale-workers)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, existing Radix/shadcn UI primitives (041-conversation-modes)
- PostgreSQL 16 with `pgvector`; additive retrieval-settings persistence inside existing `attribute_controls` JSON plus additive assistant-turn audit metadata (041-conversation-modes)
- TypeScript 5.9 on Node.js 22 + `@modelcontextprotocol/server`, Zod v4, first-party Radioso HTTP/SDK client adapter, Vitest, tsx (043-mcp-context-server)
- No new persistence; existing Radioso PostgreSQL state accessed only through existing HTTP APIs (043-mcp-context-server)
- TypeScript 5.9 on Node.js 22 + `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, Zod v4, Vitest, tsx, Node built-ins (`crypto`, `fs`, `http`) (043-mcp-context-server)
- No new database persistence; existing Radioso PostgreSQL state is accessed only through existing HTTP APIs. MCP access sessions and approval grants are package-owned in-memory state behind replaceable store interfaces. (043-mcp-context-server)
- TypeScript 5.9 on Node.js 22 + `@modelcontextprotocol/server`, Zod v4, Vitest, tsx, Node built-ins (`crypto`, `fs`, `http`) (043-mcp-context-server)
- TypeScript 5.9 on Node.js 22 + `@modelcontextprotocol/server`, Zod v4, Vitest, tsx, Node built-ins (`crypto`, `fs`, `http`), a Redis client for optional shared-store mode (043-mcp-context-server)
- Existing Radioso PostgreSQL state remains behind HTTP APIs; package-owned MCP session and approval state must support both in-memory local mode and shared-store mode for multi-instance hosting (043-mcp-context-server)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend for later analytics emitters only) + Express, `pg`, Pino, Zod, OpenAI SDK, Vitest, Supertest, existing audit and retrieval modules; planned vendor-neutral telemetry and metrics libraries only when implementation begins (045-oss-observability)
- PostgreSQL 16 with `pgvector`; existing `audit_events` as the initial durable event sink; no new external storage required for the planning phase (045-oss-observability)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest, Next.js App Router, existing dashboard settings docs pipeline (044-async-chat-jobs)
- PostgreSQL 16 with `pgvector`; existing conversations, messages, audit events, and document-processing jobs; no new persistence required in this feature (044-async-chat-jobs)
- TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, Zod, `pg`, Pino, Vitest, Supertest, Next.js App Router, shadcn/Radix UI primitives (045-password-reset-email)
- PostgreSQL 16 with existing `sessions`, `users`, `account_memberships`, `audit_events`; additive `password_reset_tokens` table (045-password-reset-email)


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
- Do not hard-code user-facing assistant or chat response strings in application code. This is a multilingual system, so runtime conversational copy must come from the LLM. If prompt text is extracted from backend code, store it under `backend/prompts/`.

## Documentation

- Before creating or revising documentation, read [`docs/document-writer-prompt.md`](docs/document-writer-prompt.md) and follow it. This applies to `readme.md`, files under `docs/`, files under `docs-portal/content/`, and settings docs used by the product UI.
- When delivering a new feature through Speckit, review the root `readme.md` before closing the work.
- Update `readme.md` whenever the feature changes the Docker run flow, authentication or token setup, common API usage, or the most important ingestion or retrieval settings operators are likely to tune.
- Store backend runtime LLM prompt templates under `backend/prompts/`. Do not add new runtime prompt files at repo root `/prompts`; if prompt text is extracted from backend code, the destination is `backend/prompts/`.

## Recent Changes
- 045-oss-observability: Added TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend for later analytics emitters only) + Express, `pg`, Pino, Zod, OpenAI SDK, Vitest, Supertest, existing audit and retrieval modules; planned vendor-neutral telemetry and metrics libraries only when implementation begins
- 045-password-reset-email: Added TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, Zod, `pg`, Pino, Vitest, Supertest, Next.js App Router, shadcn/Radix UI primitives
- 044-async-chat-jobs: Added TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend) + Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest, Next.js App Router, existing dashboard settings docs pipeline
- 043-mcp-context-server: Added TypeScript 5.9 on Node.js 22 + `@modelcontextprotocol/server`, Zod v4, Vitest, tsx, Node built-ins (`crypto`, `fs`, `http`), a Redis client for optional shared-store mode
- 042-autoscale-workers: Added TypeScript 5.x on Node.js 22 + Express, `pg`, Zod, Pino, Vitest, Supertest, `@google-cloud/tasks`, existing local connector/document packages
