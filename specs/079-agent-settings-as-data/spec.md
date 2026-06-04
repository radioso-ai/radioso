# Feature Specification: Agent Settings as Exportable Agent Data (Directives First)

**Feature Branch**: `079-agent-settings-as-data`
**Created**: 2026-06-05
**Status**: Draft
**Input**: Design discussion — "we need all agent settings to be agent data that can be exported — also directives." Started from "how do we display directives in the UI / I'd rather see directive creation and editing." Design note + rubber-duck critique: `.context/agent-settings-as-data.md`.

**Scope Note**: Today an agent is **one `agents` row** plus JSONB columns (`behavior_settings`, `greeting_settings`, `output_modes`, `skill_settings`), two override columns, and one join table (`agent_document_sources`); the repository does a single-pass full load into a runtime `ConversationAgent`. **Directives** (Parlant-guideline-style behavior rules: condition + action + priority + criticality + relationships) are **not** agent data at all — they are composition-registered constants (`backend/src/modules/directives/defaultAnswerDirectives.ts`) resolved per turn. There is a **dormant, production-unused** LLM coherence checker in `packages/conversation-kit/src/coherence.ts`.

This feature establishes the principle **"all agent settings are agent data that can be exported"** and makes **authored directives the first new agent-owned setting**. It does **two** things:

1. **Directives become authored agent data** — operators create/edit/delete natural-language directives **on an agent**; they persist in a dedicated `agent_directives` child table, steer that agent's answers, and are surfaced in the agent settings UI with an **advisory** coherence check.
2. **All agent settings become one canonical, versioned, export-*ready* projection** — a derived `AgentConfig` serializer (with `schemaVersion` and per-field portability metadata) that includes directives and every other setting, marking secrets/refs so a future export/import can be built safely.

This is **Option A: model now, export endpoint later.** We are **not** building the export/import HTTP surface or reference re-mapping in this feature — only the data model and the export-ready projection.

**Reversal recorded**: an earlier sketch stored directives as a JSONB array on the agent row. The rubber-duck review found `AgentRepository.update` rewrites every JSONB column with **no optimistic-concurrency guard** (`backend/src/db/repositories/agentRepository.ts`), so blob-stored directives inherit and amplify a lost-update bug. Directives therefore land in a **child table**, not a JSONB array. The "exports for free" argument is illusory — a child table serializes identically via one `json_agg`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author Directives on an Agent (Priority: P1)

As an operator, I want to create, edit, and delete behavior directives on a specific agent — each a named rule with a condition ("always" or "when X happens") and an action ("do Y") — so I can shape how that assistant answers without touching code, and so two assistants can behave differently.

**Why this priority**: This is the headline ask ("I'd rather see directive creation and editing") and the load-bearing data-model work. It makes directives real agent data and is the prerequisite for everything else.

**Independent Test**: Add a directive to agent A (e.g. condition `always`, action "answer in a formal register"); leave agent B with none. Run the same question against both. Assert A's answer reflects the directive and B's does not, and that A's directive survived a reload.

**Acceptance Scenarios**:

1. **Given** an agent with no authored directives, **When** an operator creates one with a valid condition + action, **Then** it persists as agent data, is returned on the next agent load, and steers that agent's next turn.
2. **Given** an agent with an authored directive, **When** an operator edits its action or deletes it, **Then** the change is persisted and reflected in the next turn, with no effect on any other agent.
3. **Given** two operators editing the same agent, **When** one adds a directive while the other toggles an unrelated behavior setting, **Then** neither change clobbers the other (directive writes do not rewrite the behavior-settings blob).
4. **Given** an authored directive naming a `requiredCapability`, **When** it is saved, **Then** the capability name is validated against the registered capability set and rejected if unknown.

---

### User Story 2 - All Agent Settings as One Export-Ready Object (Priority: P1)

As a platform maintainer, I want every agent setting — behavior, greeting, surfaces, skill settings, source scope, model override, **and authored directives** — exposed as one canonical, **versioned** `AgentConfig` object, with secrets and workspace-bound references clearly marked, so the whole agent is portable data and a future export/import has a single honest contract to build on.

**Why this priority**: This is the "wider than directives" principle the user asked for. Without it, directives would be just another bolt-on. It is delivered as a **derived projection**, not a refactor of existing types, so it is low-risk and shippable alongside US1.

**Independent Test**: Serialize a fully-configured agent. Assert the object contains every persisted setting plus authored directives plus a `schemaVersion`; assert channel tokens, `sourceScope` source IDs, logo storage refs, and embed allowed-origins are marked (`secret`/`ref`) and excluded or emitted as typed placeholders — never as raw portable values.

**Acceptance Scenarios**:

1. **Given** a configured agent, **When** `serializeAgentConfig` runs, **Then** it returns one object with `schemaVersion` and every behavior/greeting/surface/skill/scope/model setting plus authored directives.
2. **Given** the same agent, **When** the projection is produced, **Then** each field carries portability classification (`portable` | `ref` | `secret`), and `secret`/`ref` fields are omitted or placeheld, not leaked.
3. **Given** the projection, **When** a new setting is later added to the agent, **Then** including it in the canonical object requires adding it in exactly one serializer location (not five schema sites).

---

### User Story 3 - Coherence Advisory When Authoring (Priority: P2)

As an operator, when I save a directive I want to be told if it conflicts with the agent's existing directives (including the built-in defaults) — e.g. one says "always answer briefly" and another "always give exhaustive detail" — without being blocked from saving, so I catch contradictions early but stay in control.

**Why this priority**: It activates the dormant coherence checker and turns directive authoring from "type free text and hope" into a guided surface. It depends on US1 (there must be authored directives to check) and is advisory, so it can land after the MVP.

**Independent Test**: Author a directive that contradicts a built-in default (e.g. contradicting the concise-formatting directive). Assert the conflict is surfaced with a human-readable rationale and the named conflicting directive, and that the operator can still choose to save.

**Acceptance Scenarios**:

1. **Given** an agent with existing directives (authored and/or built-in), **When** an operator saves a contradictory directive, **Then** the response includes a coherence verdict listing the conflict(s) and rationale, **and the save still succeeds** (advisory, not a hard block).
2. **Given** the coherence model returns an unparseable/failed response, **When** an operator saves, **Then** the save is **not** blocked (fail-open for an advisory check) and the UI shows "coherence check unavailable".
3. **Given** an agent with no existing directives, **When** the first authored directive is checked, **Then** the built-in defaults are included as the comparison set so authored-vs-built-in conflicts are not silently skipped.

---

### User Story 4 - Directives in the Agent Settings UI (Priority: P2)

As an operator, I want a Directives section in the agent settings where I can see all directives steering this agent (including built-ins, read-only), add and edit my own, and see coherence warnings inline, so authoring is a real product surface rather than an API-only capability.

**Why this priority**: This is the visible deliverable of the original request. It depends on US1 (API) and benefits from US3 (advisory). It is P2 because some of its shape depends on Open Decisions (route field, coherence UX) we want settled first.

**Independent Test (Playwright)**: Open an agent's Directives section, create a directive, see it listed; trigger a coherence conflict and see the warning; verify built-in directives show as read-only. Confirm the agent's chat reflects the new directive.

**Acceptance Scenarios**:

1. **Given** the agent settings, **When** an operator opens Directives, **Then** they see authored directives (editable) and built-in defaults (read-only) governing this agent.
2. **Given** the editor, **When** an operator saves a conflicting directive, **Then** the coherence warning renders inline with the rationale and the operator can save anyway.

---

### User Story 5 - Eval Replay Sees Directives (Priority: P3)

As an evaluation maintainer, I want the agent snapshot used for eval replay to capture authored directives, so replaying a captured turn reproduces the behavior the directives produced instead of silently diverging when directives change.

**Why this priority**: `AgentSnapshot`/`freezeAgent` is what `EvalSnapshotService.capture` persists as `originalAgent`. Today it deliberately drops display settings — but if directives are behavior data, omitting them makes replay wrong. P3 because it is correctness-of-tooling, not an operator-facing flow.

**Independent Test**: Capture a snapshot for an agent with authored directives; mutate the agent's directives; replay the snapshot. Assert replay uses the snapshotted directive set, not the live one.

**Acceptance Scenarios**:

1. **Given** an agent with authored directives, **When** a snapshot is frozen, **Then** the snapshot includes the authored directive set.
2. **Given** a captured snapshot, **When** the agent's live directives later change, **Then** replay reconstructs behavior from the snapshot's directives.

---

### Edge Cases

- **Name collision with a built-in**: an authored directive reuses a built-in's `name` (e.g. `concise-readable-formatting`). Resolution today is undefined (no dedup; both enter the catalog and match by name). MUST define collision semantics — default: **reject on save** (a built-in name is reserved).
- **Route scope of authored directives**: built-ins are route-scoped via an **identity-keyed `WeakMap`** (`answerDirectiveRoutePolicy.ts`); deserialized authored directives have no entry, so the current code treats them as **all-routes** and they fire on `social_only` / `assistant_identity` too. Authored directives MUST carry an explicit persisted `routes` field; absent → a documented sensible default (see Open Decision G1).
- **Default priority**: an authored directive with no `priority` defaults to 0 and sinks **below** all built-ins (60/80/90). MUST decide an authored default band so operator rules are not silently weakest (G6).
- **Untrusted directive text → LLM**: `condition.description` and `action` are free text fed into matcher and coherence prompts. MUST bound length and treat as untrusted prompt input.
- **Capability reference**: `requiredCapabilities` may name a capability the operator cannot grant or that does not exist → directive silently never fires. MUST validate against the registered capability set on save.
- **Disabling a built-in**: operators may want to turn off a built-in (e.g. inline-links). There is **no** `enabled`/override field on `Directive` today. Out of scope for v1 (G4): authored directives may only **add** behavior, not disable built-ins.
- **Concurrent agent edits**: the agent whole-row update has no optimistic-concurrency guard; this feature MUST add one (version or `updated_at` guard) so directive and settings writes do not silently clobber.
- **Export-ready, not exported**: there is no endpoint that emits `AgentConfig` over HTTP in this feature; the projection exists and is unit-tested, but import/re-mapping of refs/secrets is explicitly deferred.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved. (User authorized autonomous execution of Option A in the originating discussion.)
- Backend MUST be Node.js; frontend MUST be React.
- Database MUST be PostgreSQL with `pgvector`.
- LLM integrations (the coherence checker) MUST use the centrally-configured default provider/model via the existing resolver (`backend/src/shared/infra/llm/providerConfig.ts` / `resolveLlmConfig`), not a new hard-coded default site.
- User-facing assistant copy MUST come from the LLM. Directive `action`/`condition` text is **operator-authored configuration**, not application-hard-coded conversational copy, and is multilingual by construction (matcher/coherence prompts judge by meaning, any language) — no English keyword lists in code.
- Backend development MUST follow TDD: failing tests first.
- Frontend user-visible behavior MUST prefer Playwright; unit tests stay on non-visual logic.
- Secrets MUST stay in `.env`; update `.env.example` if config is added.
- Admin-facing pages MUST use the shared dark theme and design tokens.
- Modular boundaries MUST be preserved between transport, orchestration, domain, and persistence.
- This spec MUST identify files/modules that must stay responsibility-limited (see Architecture Constraints).

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - **Agents module** (`backend/src/modules/agents/`) owns persisted directive **data**: the `agent_directives` table mapping, repository load/save, the `AgentConfig` serializer, and authoring validation. The agent surface (REST) is the transport for directive CRUD.
  - **Directives module** (`backend/src/modules/directives/`) owns **resolution only** (matching, relationship resolution, steering). Per its own README ("a Directive steers, it never acts; this module depends on no other domain module"), it MUST NOT learn about the `agents` table or persistence. It receives a directive set; it does not load one.
  - **`conversation-defaults`** owns the **relocated** coherence checker (shared by backend + kit). Backend already depends on `@radioso/conversation-defaults`; the kit does too; `conversation-defaults` depends only on `conversation-contract` → acyclic.
  - **Composition** (`backend/src/app/composition/`) assembles: the coherence gate, and the **merge** of authored directives ∪ built-in defaults into the steering catalog. Merge policy is composition wiring, not domain rules baked into either module.
  - **Conversation engine** stays capability-neutral and unaware of authoring.
- **Encapsulation Rule**:
  - `AgentRepository` stays persistence-only; it gains a directives load (one `json_agg` lateral, mirroring the existing `agent_document_sources` subquery) and an optimistic-concurrency guard, not orchestration.
  - The canonical `AgentConfig` is a **derived projection** (`serializeAgentConfig`); it MUST NOT replace or merge the five existing agent shapes (input Zod, runtime `ConversationAgent`, `AgentSnapshot`, OpenAPI request schema, OpenAPI response schema). It composes existing pieces + directives + version.
  - The coherence checker file is **relocated, not re-implemented**; it has zero kit-specific dependencies.
- **New Seams Required**:
  1. `agent_directives` table + repository port methods (list/create/update/delete by agent, scoped to workspace).
  2. `serializeAgentConfig(agent, directives): AgentConfig` projection with `schemaVersion` + per-field portability metadata.
  3. An `AuthoredDirectiveStore`/loader port the steering composition reads to merge authored directives with built-ins (directives module stays load-agnostic).
  4. A coherence **advisory** gate in the agent authoring path (non-blocking).
- **Anti-Goals**:
  - Do **not** build the export/import HTTP endpoint or reference re-mapping (deferred).
  - Do **not** collapse the five agent shapes into one type.
  - Do **not** store directives as a JSONB array; do **not** backfill the three built-ins into `agent_directives`.
  - Do **not** make coherence a hard 409 gate (advisory only; fail-open).
  - Do **not** move directive persistence into the directives module, or teach the directives module about the agents table.
  - Do **not** touch `syncLegacyWorkspaceDefaults` (flag it as a future import-time landmine; out of scope now).
  - Do **not** add an English keyword/verb list anywhere to interpret directives.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An agent MUST own zero or more **authored directives**, persisted in a dedicated `agent_directives` child table with `UNIQUE(agent_id, name)`, loaded in the single-pass agent load. Directives MUST NOT be stored as a JSONB array on the agent row.
- **FR-002**: An authored directive MUST carry: `name`, `condition` (`always` | `contextual` + `description`), `action`, optional `priority`, optional `criticality`, optional `requiredCapabilities`, optional `dependsOn`/`excludes` (by name), an explicit `routes` scope, optional `description`/`metadata`, and timestamps. Free-text fields MUST be length-bounded.
- **FR-003**: Operators MUST be able to create, edit, list, and delete an agent's authored directives via the agent (REST) surface, scoped to the agent's workspace. Directive writes MUST NOT rewrite the agent's other JSONB settings blobs.
- **FR-004**: The agent whole-row update path MUST gain an optimistic-concurrency guard (version or `updated_at` check) so concurrent edits cannot silently clobber settings or directives.
- **FR-005**: At steer time, the resolved directive set MUST be **authored directives ∪ built-in defaults**, fed through the existing match → capability-filter → relationship-resolution pipeline. Built-ins remain composition-owned constants and MUST NOT be backfilled into the table.
- **FR-006**: Authored directives MUST be **route-scoped** by their persisted `routes` field (built-ins keep their existing route policy). The identity-keyed WeakMap route policy MUST NOT be relied on for deserialized directives.
- **FR-007**: An authored directive whose `name` collides with a built-in's name MUST be rejected on save (built-in names are reserved). Collisions among an agent's own authored directives are prevented by `UNIQUE(agent_id, name)`.
- **FR-008**: `requiredCapabilities` on an authored directive MUST be validated against the registered capability set on save; unknown capabilities MUST be rejected.
- **FR-009**: Saving a directive MUST run an **advisory** coherence check comparing the candidate against the agent's existing directives **including built-in defaults**. The verdict (coherent | conflicts[] + rationale) MUST be returned to the caller. The check MUST NOT block the save, and MUST fail open if the model errors or returns unparseable output.
- **FR-010**: The coherence checker MUST be **relocated** to `conversation-defaults` (shared by backend + kit) and use the centrally-configured LLM provider/model. No second copy of the checker may exist.
- **FR-011**: The system MUST expose a derived, versioned `AgentConfig` projection (`serializeAgentConfig`) covering **all** agent settings plus authored directives, with a `schemaVersion` and per-field portability classification (`portable` | `ref` | `secret`). `secret` (channel tokens) and `ref` (sourceScope source IDs, logo storage refs, embed allowed-origins) fields MUST be omitted or emitted as typed placeholders, never as raw portable values.
- **FR-012**: `AgentSnapshot`/`freezeAgent` MUST capture the agent's authored directive set so eval replay reconstructs directive-driven behavior; live directive changes MUST NOT affect a captured snapshot's replay.
- **FR-013**: The agent settings UI MUST add a **Directives** section: built-in directives shown read-only; authored directives creatable/editable/deletable; coherence conflicts surfaced inline and non-blocking.
- **FR-014**: HTTP contract changes MUST be made in the code-first OpenAPI registry (`backend/src/app/http/openapi/`) using Zod schemas, the hand-authored agent OpenAPI schemas (`agentSchemas.ts`) MUST be updated, and `backend/openapi.yaml`/`.json` regenerated; `test:contract` MUST pass.
- **FR-015**: Adding fields to the shared `Directive` contract (`routes`, etc.) MUST include a message-queue/cross-service impact review (engine `ProcessTurnInput.directives`, kit, worker payloads) per the constitution, stating what does/doesn't change.
- **FR-016**: Documentation MUST be updated for the new directive-authoring surface and the `AgentConfig` concept (settings docs / API docs / relevant local READMEs).

### Key Entities *(include if feature involves data)*

- **AuthoredDirective** (row in `agent_directives`): the operator-owned behavior rule. `id`, `agent_id`, `name` (unique per agent), `condition`, `action`, `priority`, `criticality`, `required_capabilities`, `depends_on`, `excludes`, `routes`, `description`, `metadata`, `created_at`, `updated_at`.
- **AgentConfig** (projection, not a table): the canonical, versioned, export-ready view of an agent — all settings + authored directives + `schemaVersion`; each field classified `portable` | `ref` | `secret`.
- **DirectiveCoherenceVerdict** (advisory result): `coherent: boolean`, `conflicts: [{ directiveName, reason }]`, `rationale`. Returned on save; never blocks.
- **Built-in directives** (unchanged, composition constants): the three default answer directives; route-scoped, code-owned, read-only in the UI, merged at steer time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can create a directive on an agent and observe its effect on that agent's next answer, with no effect on any other agent — verified end-to-end.
- **SC-002**: A directive write does not modify the agent's behavior/greeting/surface/skill settings blobs (no lost-update) under concurrent edits — verified by a concurrency test.
- **SC-003**: `serializeAgentConfig` round-trips every persisted agent setting plus authored directives into one versioned object, with 100% of secret/ref fields marked and excluded/placeheld — verified by unit test over a fully-configured agent.
- **SC-004**: Saving a directive that contradicts a built-in default returns a coherence conflict with rationale **and still persists** — verified end-to-end; a model failure does not block the save.
- **SC-005**: An authored directive is route-scoped per its `routes` field and does not fire on routes it does not target — verified by a steering test.
- **SC-006**: Replaying a captured eval snapshot uses the snapshot's directive set, not the live one — verified by a snapshot/replay test.
- **SC-007**: Adding a new agent setting to the canonical config requires a change in exactly one serializer site (not the five schema shapes) — demonstrated.

## Open Decisions / Gates

- **G1 — Default `routes` for authored directives**: built-ins split as concise-formatting → [RETRIEVAL, SOCIAL_ONLY, ASSISTANT_IDENTITY], org-voice/links → [RETRIEVAL]. Proposed default for an authored directive with no explicit routes: **content routes only (RETRIEVAL)**, with the editor allowing route selection. **Needs user confirmation** — and `routes` on the persisted/contract shape is a contract addition (FR-015).
- **G2 — Name-collision semantics**: proposed **reject** an authored name that shadows a built-in (built-in names reserved). Alternative: authored shadows built-in. Recommend reject.
- **G3 — Coherence UX/timing**: proposed **synchronous advisory on save** (verdict returned with the saved directive), warn-and-confirm in the UI, fail-open. Alternative: explicit "check coherence" action or async surfacing. Recommend sync advisory for v1; revisit if latency hurts.
- **G4 — Disabling/overriding built-ins**: **out of scope for v1** (no `enabled`/override contract field). Authored directives may only add behavior. Confirm deferral.
- **G5 — Snapshot fidelity depth**: v1 freezes the **authored** directive set (US5). Recording which directives actually *fired* per turn (route- and match-dependent) is a richer follow-up; confirm v1 = freeze authored set only.
- **G6 — Authored default priority band**: proposed authored directives default to a mid band (e.g. ~50) so they sit among but not above the high-criticality built-ins (links=90). Needs a chosen number.
- **G7 — Frontend depth this iteration**: list + create/edit/delete + inline coherence is the target; built-ins read-only. Confirm whether route selection and relationship (`excludes`/`dependsOn`) editing are in the first UI or deferred to an "advanced" affordance.
