# Implementation Plan: Directive Skill Binding

**Branch**: `099-directive-skill-binding` | **Date**: 2026-07-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/099-directive-skill-binding/spec.md`

## Summary

Directives gain an optional binding target (discriminated object, only kind `skill` in
this slice). When a matched directive carries a binding and the bound skill resolves to
an enabled, registered turn skill, `ChatTurnSkillSelector` routes the turn to that skill.
Deterministic conflict ordering, graceful fall-through when the skill is unavailable,
engine-trace + warn-log observability, agent-config export/import round-trip, OpenAPI +
SDK regen, and docs. Backend only; matcher, engine ordering, steering rendering, and
frontend are untouched.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend), workspace packages
**Primary Dependencies**: Express, Zod, Kysely, pino; `@radioso/conversation-contract` types
**Storage**: PostgreSQL 16 — one nullable JSONB/text column on `agent_directives` (migration `119_*`)
**Testing**: Vitest unit + contract tests (`backend/tests/contract`), targeted integration where cheap
**Target Platform**: Backend API + conversation engine packages
**Project Type**: Web (backend slice only)
**Performance Goals**: No new LLM calls; binding resolution is pure in-memory work per turn
**Constraints**: No matcher/prompt changes; no engine loop reordering; no steering-render changes
**Scale/Scope**: ~1 migration, 1 contract type extension, 1 pure helper module, selector wiring, schema/API/OpenAPI/SDK/docs updates

## Constitution Check

- Spec exists and is **Approved** (`specs/099-directive-skill-binding/spec.md`).
- Backend TDD: every phase below starts with failing Vitest tests (unit for the binding
  resolver, schema validation, config round-trip; contract tests for the API field).
- No frontend work in this slice (spec anti-goal), so no Playwright additions; existing
  suites must stay green (SC-005).
- Stack unchanged: Node.js backend, PostgreSQL. No pgvector interaction.
- No LLM provider changes; explicitly **no new prompts** and no matcher prompt edits
  (spec constitution constraint).
- No secrets/config changes; `.env.example` untouched.
- Customer data: binding metadata only (skill names); warn logs carry ids/names, never
  message content (FR-005).
- Module boundaries: contract type in `packages/conversation-contract`; authoring
  validation + persistence mapping in `backend/src/modules/agents/`; binding resolution
  as a pure module consumed by `ChatTurnSkillSelector` in `backend/src/modules/chat/`;
  no composition changes (no new app-wide adapters/registries — existing wiring already
  passes directives and skills where needed). Composition ownership: **N/A**.
- OpenAPI: code-first registry update in `backend/src/app/http/openapi/` (agent schemas)
  + `pnpm run generate:openapi`; `backend/openapi.yaml`/`.json` regenerated, never
  hand-edited. TypeScript SDK updated via `typescript-sdk` `pnpm run sync` chain.
- Message-queue impact review: **none** — binding is consumed in-turn inside chat
  selection; no worker dispatch, AMQP payloads, retry semantics, or queue docs affected.
- Docs parity: `docs/architecture/conversational-directives.md` +
  `docs-portal/content/api/agents-and-skills.mdx` (FR-011) in the same change.

## Project Structure

### Documentation (this feature)

```text
specs/099-directive-skill-binding/
├── plan.md              # This file
├── research.md          # Decisions (field shape, namespace, ordering)
├── data-model.md        # agent_directives column + contract/API shapes
├── quickstart.md        # How to exercise the binding end-to-end
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
packages/conversation-contract/
└── index.d.ts                          # Directive gains optional `binding` (target union)

backend/
├── src/db/migrations/119_agent_directive_binding.sql   # nullable binding column
├── src/db/                              # regenerated Kysely types (pnpm run db:types)
├── src/modules/agents/
│   ├── authoredDirectives.ts            # schema + limits + AuthoredDirective field
│   ├── authoredDirectiveMapper.ts       # row <-> domain mapping
│   └── agentConfig.ts                   # AuthoredDirectiveConfig projection (export/import)
├── src/modules/chat/services/
│   ├── directiveBindingResolution.ts    # NEW pure helper: winner + availability fall-through
│   └── turnSkillSelector.ts             # consumes resolver in resolveSkill/select + trace reason
├── src/modules/directives/              # domain mapping if DirectiveMatch plumbing needs it
├── src/app/http/openapi/schemas/agentSchemas.ts  # request/response binding field
├── openapi.yaml / openapi.json          # generated (pnpm run generate:openapi)
└── tests/                               # unit + contract coverage

typescript-sdk/                          # pnpm run sync (generated types pick up field)
docs/architecture/conversational-directives.md
docs-portal/content/api/agents-and-skills.mdx
```

**Structure Decision**: Web-application layout (existing). Transport stays in
`agentRoutes.ts` (validation call only); domain rules split between the agents module
(authoring) and a new pure chat-module helper (runtime resolution); persistence via the
existing directives repository/mapper; contract type is the single shared shape.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/agentRoutes.ts:321-397` — existing
  directive CRUD routes; only gains schema-level field + service validation call. No
  business rules here.
- **Orchestration Layer**: `ChatTurnSkillSelector`
  (`backend/src/modules/chat/services/turnSkillSelector.ts`) — the ONLY selection-time
  consumer. `resolveSkill(session)` currently does first-`selects()`-wins; it will first
  consult the binding resolver with `session.directiveSteering?.matches` and the
  registered turn skills, falling back to today's behavior. `select()` carries the
  binding-driven `SelectionDecision.reason` (`directive:<name>`) and losing/skipped
  binding records for the engine trace. `TurnSelectionStrategy` stays candidate/reason
  policy — untouched decision-wise.
- **Domain Layer**: NEW `directiveBindingResolution.ts` — pure, unit-testable: input =
  directive matches + available turn-skill names (+ agent-enabled skill names), output =
  `{winner?, losers[], skipped[]}` per FR-004/FR-005 ordering (priority desc with
  default 50, confidence desc with deterministic matches ranking as certain, directive
  name asc). Authoring validation rule (exists + enabled + turn-capable invocation mode)
  lives in the agents module beside `authoredDirectives.ts`.
- **Persistence/Integration Layer**: migration `119_agent_directive_binding.sql`
  (nullable column on `agent_directives`), Kysely types regenerated via `db:types`,
  mapping in `authoredDirectiveMapper.ts`. `DirectiveMatch` already carries the full
  `Directive` (contract `index.d.ts:109-114`), so once `Directive.binding` exists the
  value reaches selection with no new plumbing.
- **Application Composition**: N/A — no new adapters/registries; existing composition
  already wires directives into session prep and skills into the selector.
- **Files Kept Small**: `turnSkillSelector.ts` stays a thin seam (resolution logic goes
  in the helper); `agentRoutes.ts` gains no logic; the engine
  (`packages/conversation-engine/src/index.ts`) is NOT modified; matcher files and
  `backend/prompts/chat/directive-match.md` are NOT modified.
- **Planned Extractions**: `directiveBindingResolution.ts` (pure helper) is the only new
  module.
- **Required Refactor Stories**: none — the seam verified during spec review is safe:
  matches are computed before selection and already flow into the selector.

## Decisions Locked During Spec Review

1. Binding shape: discriminated target object; persisted/API shape must accept a future
   `routine` kind without migration → store as JSONB `binding` column
   (`{"kind":"skill","skillName":"..."}`); Zod schema accepts only `kind: "skill"`.
2. Namespace: authored validation checks the agent's `agent_skills` rows (exists,
   `enabled`, turn-capable invocation mode — routine-only rejected); runtime maps
   `skillName` → registered `TurnSkill.definition.name`, fall-through when absent.
3. Import (agent config) bypasses authoring validation by design; runtime fall-through
   governs (FR-009).
4. Trace system of record: engine `ConversationTrace` selection decision — winner reason
   `directive:<name>`, plus losing/skipped binding records (FR-008); warn log event for
   skips with workspace/agent/conversation/directive/skill/reason only.
5. Routine turns never evaluate bindings (routine path does not run terminal skill
   selection); routine/step-scoped directives with bindings are accepted-but-inert and
   documented as such.

## Complexity Tracking

No constitution violations to justify.
