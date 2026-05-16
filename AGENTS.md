# Radioso

## What This Is

Radioso is a self-hosted context platform for grounded assistants. It provides document ingestion, retrieval, assistant chat, website embed, a REST API, a first-party TypeScript SDK, and an MCP server.

This file is hand-maintained. Do not regenerate it from Speckit plans, append "recent changes", paste run logs, or add feature-specific scratch notes here. Use `specs/`, `docs/`, or `.context/` for work-in-progress context.

## Stack

| Concern | Choice |
|---------|--------|
| Backend | TypeScript on Node.js 24, Express |
| Frontend | TypeScript 5.7, React 19, Next.js 16 App Router |
| Database | PostgreSQL 16 with `pgvector` |
| Validation | Zod |
| Logging | Pino |
| AI providers | OpenAI SDK and provider adapters |
| UI primitives | Radix UI, shadcn-style components, Lucide icons |
| Tests | Vitest, Supertest, Playwright |
| Local runtime | Docker Compose via `./run-dev.sh` |
| Enterprise local runtime | Host services via `./run-ee-dev.sh` |
| Package manager | `pnpm` workspace from repo root |

## Architecture

```
Browser / website embed
          |
          v
+----------------------+
| frontend/            |  Next.js dashboard and chat UI
+----------+-----------+
           | HTTP
           v
+----------------------+
| backend/             |  Express API, auth, settings, assistant, retrieval
+----+-----------+-----+
     |           |
     v           v
PostgreSQL   document worker
pgvector     chunking, parsing, embedding
     ^
     |
+----+-----------------+
| packages/            |  MCP server, parser, connector contracts
+----------------------+
```

## Key Architectural Decisions

- **Assistant and retrieval are separate surfaces.** Use assistant APIs for human-facing chat, persona, history, and channel routing. Use retrieval APIs for grounded search or answers without assistant behavior.
- **PostgreSQL is the system of record.** Application state, documents, chunks, vectors, settings, sessions, and audit events live in Postgres. Do not introduce a new storage system without a feature plan.
- **Document processing is asynchronous.** Upload paths should enqueue or update processing state; chunking, parsing, embedding, and connector work belong in worker flows.
- **Application composition owns replaceable runtime wiring.** When backend work adds or swaps app-wide adapters, registries, sinks, lifecycle hooks, capability policies, storage/dispatcher implementations, or other cross-module infrastructure, evaluate `backend/src/app/composition/` and wire the default behavior there. Keep domain rules in `backend/src/modules/` or `backend/src/shared/domain/`; composition should assemble implementations, not own product logic.
- **Contract changes require message-queue review.** When changing public APIs, SDK contracts, MCP contracts, connector contracts, worker payloads, or other cross-service contracts, review whether document worker dispatch, AMQP queue payloads, retry semantics, or queue docs/tests need updates.
- **Runtime LLM prompt templates live under `backend/prompts/`.** Do not add runtime prompts at repo root.
- **User-facing assistant copy comes from the LLM.** Do not hard-code conversational assistant responses in application code.
- **Docs are product surface.** If a change affects setup, auth, APIs, ingestion, retrieval settings, SDK usage, or MCP usage, update the relevant docs in the same change.

## Commands

Full local stack:

```bash
./run-dev.sh
```

Backend:

```bash
cd backend
pnpm run dev
pnpm run dev:worker
pnpm run build
pnpm test
pnpm run test:unit
pnpm run test:integration
pnpm run test:contract
```

Frontend:

```bash
cd frontend
pnpm run dev
pnpm run build
pnpm run lint
pnpm test
pnpm run test:e2e
```

Docs portal:

```bash
cd docs-portal
pnpm run dev
pnpm run build
pnpm run lint
```

MCP server package:

```bash
cd packages/radioso-mcp-server
pnpm run build
pnpm test
pnpm run smoke:all
```

TypeScript SDK:

```bash
cd typescript-sdk
pnpm run sync
pnpm run build
pnpm test
```

Enterprise Edition packages:

```bash
./run-ee-dev.sh
cd ee
pnpm run build
pnpm test
```

Before creating or updating a pull request, run local CI because GitHub CI is manual:

```bash
pnpm run ci:local -- origin/main
```

Use `pnpm run ci:local -- --all` for broad changes, and include the result in the PR body.

Use Conventional Commits for commit messages, such as `feat: add retrieval setting` or `fix: handle empty uploads`.

## Code Style

- Prefer small, named modules over large orchestration files. If a service mixes persistence, orchestration, audit, analytics, and formatting concerns, extract the most self-contained concern first.
- Keep route handlers and high-level services readable top-to-bottom. Validation, mapping, trace formatting, audit metadata, and persistence details should live in named helpers.
- Use explicit types at module boundaries. Avoid `any` in production code; use `unknown`, narrow it, or define a local type for third-party payloads.
- Prefer pure helper modules for mapping, normalization, formatting, and trace or audit payload construction.
- Do not encode product meaning, routing, retrieval strategy, intent classification, or user-facing behavior with English regexes or hard-coded keyword lists in code. Radioso is multilingual; use structured metadata, typed configuration, settings-owned rules, or prompt-returned enum fields instead. Structural regexes for format parsing, identifiers, or protocol syntax are acceptable when they do not encode English product vocabulary.
- Keep comments for non-obvious constraints, safety decisions, or business rules. Do not narrate straightforward code.
- Preserve behavior during refactors. Make extraction-only changes separately from behavior changes when practical, and verify with focused tests.
- Use Test-driven-development TDD approach for backend. First write failing tests, then complete the functionality for the tests to pass.
- For frontend, choose the most appropriate testing method between TDD for logic, React component tests or Playwright test where appropriate. Never write unit tests for CSS or layout.

## Frontend Guidance

- Prefer Playwright coverage for visible user journeys and UI behavior.
- Keep frontend unit tests focused on state transitions, data transforms, API adapters, parsing, and routing logic.
- Avoid unit-test assertions on markup structure, class names, design tokens, or cosmetic copy when an end-to-end test is a better fit.
- Use existing Radix/shadcn patterns and Lucide icons before introducing new UI conventions.

## Documentation

Before editing `readme.md`, files under `docs/`, files under `docs-portal/content/`, or settings docs used by the product UI, read `docs/document-writer-prompt.md` and follow it.

Update `readme.md` whenever a feature changes Docker run flow, authentication or token setup, common API usage, or important ingestion or retrieval settings operators are likely to tune.

## Project Layout

```
radioso/
|-- AGENTS.md                    # this file; stable hand-maintained agent guide
|-- readme.md                    # product overview and quick start
|-- backend/                     # Express API and document workers
|   |-- src/
|   |-- prompts/                 # runtime LLM prompt templates
|   `-- tests/
|-- frontend/                    # Next.js application
|-- packages/
|   |-- radioso-mcp-server/      # standalone MCP server package
|   |-- document-parser/         # local parser package
|   `-- connector-api/           # connector contract package
|-- typescript-sdk/              # first-party TypeScript SDK
|-- docs/                        # product, SDK, MCP, and settings docs
|-- docs-portal/                 # public documentation site
|-- ee/                          # commercial Enterprise Edition packages and license
|   `-- packages/
|-- infra/                       # Docker Compose and Terraform
|-- scripts/                     # bootstrap and performance scripts
|-- specs/                       # Speckit feature artifacts
`-- tests/                       # cross-cutting bootstrap/performance tests
```

## AGENTS.md Maintenance Rules

- Keep this file concise and durable. It should describe how to work in the repo, not what happened in a single run.
- Do not paste generated "Active Technologies" inventories, feature-plan histories, branch notes, logs, benchmark output, or TODO dumps here.
- When adding a new package or workflow, update the relevant table, command block, or layout entry by hand.
- Put temporary agent coordination notes in `.context/`; it is gitignored and exists for that purpose.
