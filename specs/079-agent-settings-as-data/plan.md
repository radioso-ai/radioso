# Implementation Plan: Agent Settings as Exportable Agent Data (079)

**Spec**: `specs/079-agent-settings-as-data/spec.md`
**Design note (evidence)**: `.context/agent-settings-as-data.md`

## Constitution Check

- **Spec-First**: spec authored and approved (autonomous Option-A authorization). ✅
- **Backend TDD**: every backend slice writes failing tests first (table mapping, repository load, serializer field classification, coherence advisory fail-open, steering merge + route scope, collision/capability validation, snapshot capture). ✅
- **Stack**: Node/React/Postgres+pgvector; coherence LLM via central `resolveLlmConfig`. ✅
- **Composition ownership**: the coherence gate and the authored ∪ built-in directive merge are assembled in `backend/src/app/composition/`; domain rules stay in `modules/agents` (data) and `modules/directives` (resolution). ✅
- **Code-First OpenAPI**: directive CRUD routes defined in the OpenAPI registry with Zod; `agentSchemas.ts` updated; `openapi.yaml/json` regenerated; `test:contract` green. ✅
- **Message-Queue/Contract review**: `Directive` is a shared contract type consumed by the engine (`ProcessTurnInput.directives`) and kit — see Impact Review below. ✅
- **Docs Parity**: settings + API docs updated for directive authoring and the `AgentConfig` concept. ✅
- **Frontend testing**: Directives section covered by Playwright; unit tests only for the directive form/adapter logic. ✅

## Slices (each independently testable; TDD)

Order reflects dependency. Slices 1–2 are the load-bearing P1 foundation; 3–4 are P2; 5 is P3.

### Slice 1 — Authored directives as agent data (P1 / US1)
- Migration: `agent_directives` table (`id`, `agent_id` FK ON DELETE CASCADE, `name`, `condition_kind`, `condition_description`, `action`, `priority`, `criticality`, `required_capabilities`, `depends_on`, `excludes`, `routes`, `description`, `metadata`, `created_at`, `updated_at`), `UNIQUE(agent_id, name)`, index on `agent_id`.
- Domain: `AuthoredDirective` type + Zod authoring schema (length bounds; condition discriminated union; routes enum array; capability + collision validation hooks).
- Repository: load directives via one `json_agg` lateral added to `agentColumns`; `listDirectives/createDirective/updateDirective/deleteDirective(agentId, workspaceId, …)` that write only `agent_directives` (never the settings blobs).
- **Optimistic-concurrency guard** on `AgentRepository.update` (version or `updated_at` in the `WHERE`) — latent bug fix, do regardless.
- Tests: table round-trip, single-pass load includes directives, directive write leaves blobs untouched, concurrency guard rejects stale write, name-collision-with-built-in rejected, unknown capability rejected.

### Slice 2 — Canonical export-ready `AgentConfig` projection (P1 / US2)
- `serializeAgentConfig(agent, directives): AgentConfig` in `modules/agents` — composes existing `ConversationAgent` + directives + `SCHEMA_VERSION`; per-field `{portable|ref|secret}` classification; omit/placehold `secret` (tokens) and `ref` (sourceIds, logo refs, allowedOrigins).
- Tests: every persisted setting present; secret/ref fields marked + excluded/placeheld; adding a field touches one site.
- No change to the five existing shapes.

### Slice 3 — Coherence advisory + steering merge (P2 / US3, plus US1 steering)
- Relocate `packages/conversation-kit/src/coherence.ts` → `conversation-defaults` (zero kit deps); update kit imports; backend imports from defaults.
- Advisory gate in the agent authoring path: on create/update, run checker against existing authored **∪ built-in** directives; return verdict; never block; fail open.
- Composition: merge authored (route-scoped via persisted `routes`) ∪ built-ins into the steering catalog; authored default priority band (G6); reject built-in name collisions already enforced at save.
- Tests: advisory verdict returned + save still succeeds; model failure → save succeeds; first authored directive checked against built-ins (no empty-set skip); authored directive route-scoped and does not fire off-route; authored priority band ordering.

### Slice 4 — Directives UI (P2 / US4)
- Agent settings "Directives" section: list (authored editable, built-ins read-only), create/edit/delete form (condition, action, criticality, priority, routes; relationships under advanced per G7), inline coherence warning (non-blocking).
- Playwright journey; unit tests only for form state/adapter.

### Slice 5 — Eval snapshot capture (P3 / US5)
- `AgentSnapshot`/`freezeAgent` include authored directive set; `EvalSnapshotService` replay uses snapshot directives.
- Tests: snapshot includes directives; replay uses snapshot set after live mutation.

## Impact Review (message-queue / cross-service contracts)

- `Directive` (in `packages/conversation-contract`) is consumed by the engine (`ProcessTurnInput.directives`) and the kit. This feature **adds** a persisted `routes` concept for authored directives.
  - **Decision needed (G1)**: whether `routes` lands on the shared `Directive` contract or on a backend-local authored shape that maps into `Directive` at steer time. Preference: keep `routes` on the **backend authored shape + steering input**, not the shared `Directive`, to avoid widening the cross-service contract — confirm during Slice 3.
- No new worker/AMQP payloads; directive authoring is synchronous REST. The advisory coherence call is an inline LLM call, not a queue job. **No queue contract change expected** — restate explicitly in the PR.

## Docs

- Settings doc for directive authoring (operator-facing), API doc for the directive CRUD routes, `AgentConfig`/export-readiness note, and the `modules/agents` + `modules/directives` local READMEs if ownership/entry points change. Follow `docs/document-writer-prompt.md`.

## Verification

- Per-slice: focused unit/contract tests green; `tsc` clean.
- Pre-PR: `pnpm run ci:local -- origin/main` (and `--all` given breadth), result in PR body.
- Independent verification by the orchestrator (not self-reported): run the slice tests directly and read the diff against `origin/main`.
