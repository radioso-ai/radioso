# Radioso

## What This Is

Radioso is a self-hosted platform for conversational agents that answer, act, and hand off — inside rules the operator authors. An agent answers grounded in the workspace's own documents, dispatches skills and runs multi-turn routines to carry a request end to end, and escalates to a person when a turn calls for one. You reach an agent through the web app, a website embed, the REST API, a first-party TypeScript SDK, or an MCP server; document ingestion and retrieval run behind those surfaces.

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

Operator-facing features ship a copilot tool descriptor or a stated coverage-map exclusion in the same change.

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
- **API contract changes ship with the regenerated SDK snapshot.** The published `@radioso/typescript-sdk` builds from the snapshot committed at `typescript-sdk/openapi/` and `typescript-sdk/src/generated/`, so a backend change that alters the OpenAPI contract must run `cd typescript-sdk && pnpm run sync` and commit the result in the same change. CI fails the TypeScript SDK job when that snapshot drifts, because a stale snapshot would publish types that do not match the backend.
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

Conversation-quality evals (grounded/routing/directive/routine behavior, distinct from unit tests). The deterministic harness runs in normal CI via `tests/unit/eval-suite`; the live model suite is a nightly/on-demand gate, not a per-PR check (needs Postgres, `OPENAI_API_KEY`, and a running document worker):

```bash
cd backend
pnpm run evals                 # live five-sample run, gated against the committed baseline
pnpm run evals:ci              # same five-sample gated shape the nightly workflow runs
pnpm run evals:update-baseline # re-record the committed baseline from five samples
```

Ray behaviour evals (tool selection, proposal quality, never-list adherence). The deterministic half runs in normal CI via `tests/unit/operatorCopilot/copilot-eval-suite.test.ts`; the live half runs on demand and needs Postgres plus `OPENAI_API_KEY`:

```bash
cd backend
pnpm run evals:copilot                    # one sample per case; a smoke run against a bootstrapped throwaway workspace
pnpm run evals:copilot:ci                 # sampled 3x, reduced — the gate-worthy shape
pnpm run evals:copilot:update-baseline    # re-record the committed baseline after an intended change
```

Frontend:

```bash
cd frontend
pnpm run dev
pnpm run build
pnpm run lint
pnpm test
pnpm run test:e2e       # production server, matching CI
pnpm run test:e2e:dev   # development server for rapid iteration
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

Use Conventional Commits for commit messages, such as `feat: add retrieval setting` or `fix: handle empty uploads`.

## Design Discipline

Before writing code for a non-trivial change, answer in writing:

- **What does each module / class / file know? What shouldn't it know?** A generic transport must not know about a specific provider; a domain template must not live inside a generic service; concrete adapters belong outside the contract they implement.
- **What ports does it expose, to whom?** Narrow ports per consumer beat one fat interface. Duplicated structural types across module boundaries are a missing shared port, not an acceptable workaround.
- **What's the dependency direction?** Modules with broad knowledge depend on modules with narrower knowledge, never the reverse. Composition assembles; domains never reach into composition.

Treat high file count as a smell. If a small feature wants to touch many files, the substrate is probably wrong — pause and look for the missing port, the duplicated type, or the leaking concern, and surface it before pushing through. Tests passing and types compiling are the *start* of review, not the finish line: a code change is not done until the *shape* can be defended on those three questions.

Watch for tactical tells that signal dodged design work: "for now," "the cheap one," "land this and refactor later," "minimum viable." When they appear, ask whether the shortcut is real wisdom or avoidance.

For backend feature work, explicitly review whether the change needs logs, metrics, telemetry events, audit events, or OpenTelemetry spans. Add or update observability when the change introduces a new runtime path, worker job, queue handoff, provider call, integration, failure mode, operator-relevant latency, retry, fallback, skip, degradation behavior, or support/debug correlation need across requests, jobs, conversations, documents, or workspaces. Do not add noisy logs or high-cardinality metrics by default. Observability output must avoid raw prompts, completions, document content, retrieved chunks, tokens, credentials, cookies, and connection strings. If no observability is needed, note why in the spec, plan, or PR summary.

## Context Discipline

Agent context is billed on every turn, not once. A file read on turn 3 is re-read on turns 4..N; measured amplification in this repo is roughly 600x. The bill is therefore the sum of context size across turns, driven by how long a session runs and how much it accumulates — not by any single expensive call. Optimize for what stays out of the thread.

- **One task per session.** Peak context sets the cost: a session peaking at 700k tokens costs about 5x one peaking at 150k for the same work. Start a fresh session or workspace per task instead of continuing in a warm one.
- **Delegate file-heavy work to subagents.** Any question answered by reading many files — locating a symbol, mapping a module, checking a convention, auditing a pattern — belongs in a subagent that returns only the conclusion. The parent pays for the answer, not the search.
- **Read narrowly.** Prefer targeted search and offset-limited reads over whole files. Re-reading a file already read in the same session is a defect, not a precaution.
- **Edit, don't rewrite.** Full-file writes are billed as tool input and then re-read for the rest of the session. Use targeted edits on files that already exist.
- **Keep bulk material out of the main thread.** Large logs, transcripts, and design memos belong in `.context/`, read by a subagent that reports findings.

Match model tier to task and prefer the cheapest tier that can do the job:

| Task | Claude | Codex |
|------|--------|-------|
| Architecture, ambiguous design, hard debugging | `opus` | `gpt-5.6-sol` |
| Feature implementation, code review, tests | `sonnet` | `gpt-5.6-terra` |
| Mechanical scans, greps, inventories, formatting | `haiku` | `gpt-5.6-luna` |

Orchestrate on the strong tier and fan work out on cheaper ones. A subagent running a grep sweep does not need the model that designed the change.

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

For context-efficient feature work, start with `docs/agent-context-workflow.md`, then use `docs/architecture/code-map.md` to find the owning area, public entry points, focused tests, and related specs before reading broad directories.

When changing an area that has a local `README.md` brief, read it before editing and keep it accurate if the change moves ownership, changes public entry points, adds a new recurring test path, or alters the module boundary. If a change makes agents repeatedly rediscover the same context, update the relevant local brief or `docs/architecture/code-map.md` instead of expanding this file.

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
|   |-- conversation-contract/  # reusable conversation engine contracts
|   |-- conversation-engine/    # pure conversation engine runtime loop
|   |-- mcp-source-proof/       # signed source provenance shared by MCP edge and backend
|   |-- integration-test-support/ # shared disposable integration-database policy
|   |-- radioso-mcp-server/      # standalone MCP server package
|   |-- document-parser/         # local parser package
|   |-- connector-api/           # connector contract package
|   `-- ui/                      # shared shadcn primitives (frontend + docs-portal)
|-- typescript-sdk/              # first-party TypeScript SDK
|-- docs/                        # product, SDK, MCP, and settings docs
|   `-- architecture/            # durable architecture maps and boundaries
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
