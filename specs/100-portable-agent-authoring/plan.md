# Implementation Plan: Portable Agent Authoring — US1 (deterministic markdown routines)

**Branch**: `100-portable-agent-authoring` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/100-portable-agent-authoring/spec.md`
**Delivery scope**: User Story 1 + FR-016 stage 1 only. US2 (bundle), US3 (SDK
namespaces), US4 (kit loader, validator/compiler extraction) are explicitly out of
scope for this branch and tracked in the spec.

## Summary

Promote the routine portable-markdown grammar from a frontend-private module to an
engine contract. Two new shared workspace packages: `@radioso/routine-definition`
(the `RoutineDefinition` types + Zod schemas hoisted from
`backend/src/modules/routines/domain.ts` — a move, with the backend consuming the
package) and `@radioso/routine-markdown` (the grammar extracted from
`frontend/lib/routine-prose-tokens.ts`, gaining a canonical serializer, a
self-declared grammar version in frontmatter, and `contextVariableRef` binding
support). On top of that, a deterministic markdown API per resolved OQ-005/OQ-006:
JSON envelope `{ grammarVersion, content }` on a `portable` sub-resource
(GET/PUT per routine, markdown-envelope create, and a persistence-free
`canonicalize` operation). The frontend deletes its local grammar copy and consumes
the shared package; the chip-document layer must preserve `contextVariableRef`
bindings through open→edit→save (FR-004a). No LLM calls anywhere in the new path
(SC-005); `draft-assist` is untouched.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend, packages); TypeScript
5.7 / React 19 / Next.js 16 (frontend)
**Primary Dependencies**: Zod (schemas travel with the hoisted types), Express
routes, `@asteasolutions/zod-to-openapi` code-first registry, Vitest, Playwright
**Storage**: N/A — no schema change; `RoutineDefinition` persistence is untouched;
markdown is a projection, never stored
**Testing**: Vitest (packages, backend unit/contract), Supertest (routes),
Playwright (chip-editor journey), existing round-trip corpus in
`frontend/tests/unit/routine-prose-tokens.test.ts` moves with the grammar
**Target Platform**: pnpm workspace packages consumed by backend (compiled dist,
per `build:workspace-deps` convention) and frontend
**Project Type**: web (backend + frontend + packages)
**Performance Goals**: parse/serialize are pure synchronous functions; no latency
budget concern; zero model-provider calls (SC-005, test-enforced)
**Constraints**: canonical form must be byte-stable (SC-001); stable ids preserved
through round trip; grammar documents self-declare version (missing = v1, never
"latest"); no second copy of grammar or definition types anywhere
**Scale/Scope**: ~2 new packages, ~4 backend route handlers + mapper, 1 frontend
module swap, docs; no migrations

## Constitution Check

- Spec exists and is Approved (see spec.md header) — gate passed.
- Backend TDD: envelope mapper, portable routes, and canonicalize get failing
  tests first (unit + contract). Package extraction is behavior-preserving and is
  guarded by the moved round-trip corpus plus new version/binding tests written
  red→green.
- Frontend: chip-editor binding preservation (FR-004a) is user-visible → Playwright
  journey (open a context-bound routine, edit an unrelated step, save, assert
  binding survives via API read-back). Unit tests only for the chip-document
  transform logic (non-visual), per Principle XI.
- Stack: Node.js backend, React frontend — unchanged. No DB change (PostgreSQL
  untouched). No LLM integration in scope (deterministic path; GPT-5.2 default
  irrelevant here but unviolated).
- Secrets: none introduced; `.env.example` untouched.
- Customer data: markdown content is authored configuration, not customer data;
  observability must still not log document content (FR-009).
- Module boundaries: see Module Ownership & Seams. Grammar and definition types
  become packages; routes stay transport-only; the envelope mapper is a named
  module, not handler inline code.
- Composition (`backend/src/app/composition/`): N/A — no app-wide adapters,
  registries, or lifecycle infrastructure; the portable mapper is a pure module
  wired directly by the routine routes' existing dependency injection.
- OpenAPI: new endpoints are registered code-first in
  `backend/src/app/http/openapi/document.ts`; `backend/openapi.yaml`/`.json`
  regenerated via `pnpm run generate:openapi`, never hand-edited; contract tests
  updated; `typescript-sdk` regenerated via its `sync` script (types only — SDK
  client wrapper methods are US3, out of scope).
- Message-queue impact review: **no impact.** No worker payloads, AMQP queues,
  document worker dispatch, or retry semantics are touched — routine authoring is
  a synchronous HTTP concern; the compiled runtime graph and its consumers are
  unchanged. Queue docs/tests need no updates.
- Prompt assets: none added or moved (`draft-assist` prompts untouched).
- Docs parity: grammar format reference (new, public contract), routines API docs
  in `docs/` and `docs-portal/content/`, per `docs/document-writer-prompt.md`.
- Agent context script (`update-agent-context.sh`): intentionally skipped —
  repo-level `CLAUDE.md`/`AGENTS.md` maintenance rules prohibit regenerated
  inventories in the agent guide; this plan documents the technology additions
  instead.

## Project Structure

### Documentation (this feature)

```text
specs/100-portable-agent-authoring/
├── spec.md              # Approved
├── plan.md              # This file
├── research.md          # Conventions + decisions ground truth
├── data-model.md        # Package layering + envelope shapes (no DB entities)
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
packages/
├── routine-definition/          # NEW — FR-016 stage 1
│   ├── src/index.ts             # limits, enums, Zod schemas, inferred types
│   ├── package.json             # compiled-dist convention (like conversation-engine)
│   └── tests/                   # schema behavior tests (moved + kept green)
└── routine-markdown/            # NEW — the grammar
    ├── src/
    │   ├── index.ts             # parse(), serialize(), canonicalize(), GRAMMAR_VERSION
    │   ├── tokens.ts            # moved from frontend/lib/routine-prose-tokens.ts
    │   └── frontmatter.ts       # version declaration handling
    ├── package.json
    └── tests/                   # round-trip corpus moved from frontend/tests/unit

backend/src/modules/routines/
├── domain.ts                    # becomes re-export of @radioso/routine-definition
├── portableDocument.ts          # NEW — envelope mapper: RoutineDefinition ⇄ markdown
│                                #   (uses @radioso/routine-markdown; pure; no LLM)
├── service.ts                   # gains portable read/write entry points (thin)
└── validator.ts / compiler.ts   # UNCHANGED (US4 moves them)

backend/src/app/http/routes/agentRoutes.ts   # + portable sub-resource routes
backend/src/app/http/openapi/document.ts     # + endpoint registrations
backend/tests/unit/routines/portableDocument.test.ts   # NEW (red first)
backend/tests/contract/                       # updated for new endpoints

frontend/lib/routine-prose-tokens.ts   # DELETED
frontend/lib/routine-prose.ts          # updated: imports grammar package;
                                       #   chip model round-trips contextVariableRef
frontend/components/dashboard/settings/routine-chip-editor.tsx  # import swap
frontend/tests/e2e/                    # + binding-preservation journey

docs/                                  # routine markdown format reference + API docs
docs-portal/content/                   # portable authoring page
typescript-sdk/src/generated/          # regenerated (sync script)
```

**Structure Decision**: Both new packages follow the compiled-dist convention
(`conversation-engine` pattern: `tsc` build, `main`/`types` → `dist`), because the
backend consumes workspace packages as built output via `build:workspace-deps` /
`predev:*` chains, and compiled ESM+d.ts is equally consumable by Next.js without
`transpilePackages`. `routine-definition` carries Zod as its only dependency;
`routine-markdown` depends only on `routine-definition`. Neither may import
backend, frontend, Express, React, or any model provider (spec Boundary Rule).

## Module Ownership & Seams

- **Transport Layer**: `agentRoutes.ts` — parses/validates the JSON envelope,
  delegates, maps diagnostics to HTTP; owns no grammar or mapping logic.
- **Orchestration Layer**: `modules/routines/service.ts` — existing lifecycle
  entry points gain thin portable variants (read → project to markdown; write →
  parse, then reuse the exact same save/validate path as structured intake, so
  markdown can never bypass validation).
- **Domain Layer**: `@radioso/routine-definition` (types + schemas),
  `@radioso/routine-markdown` (grammar), `modules/routines/portableDocument.ts`
  (envelope mapping + diagnostic shaping). `validator.ts`/`compiler.ts` unchanged.
- **Persistence/Integration Layer**: untouched —
  `routineDefinitionRepository.ts` still stores structured definitions only.
- **Application Composition**: N/A (no replaceable runtime infrastructure).
- **Files Kept Small**: `agentRoutes.ts` (already large — new routes must be
  handler-per-operation delegating to service; zero inline mapping),
  `service.ts` (portable variants delegate to `portableDocument.ts`).
- **Planned Extractions**: the two packages; `portableDocument.ts` as the single
  place markdown meets the definition model in the backend.
- **Required Refactor Stories**: none — extraction *is* the refactor, and it is
  sequenced first (Phase A/B) so feature work lands on clean seams.

## Complexity Tracking

No constitution violations to justify. The two-package split (vs one) is a spec
decision (OQ-004) keeping the types/schemas package free of grammar concerns so
US4 can add validator+compiler to `routine-definition` without entangling the
serializer.
