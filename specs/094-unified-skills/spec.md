# Feature Specification: Unified Skill Model (every capability is a named skill)

**Feature Branch**: `094-unified-skills`
**Created**: 2026-06-22
**Status**: Draft
**Input**: User description: "The skills UX is subpar. All skills are kind of declarable but not really, and skills need to be usable in routines. When a channel is available — Slack, MCP, email — it should be a named skill that expresses a defined set of capabilities. I want an 'Add new skill' button and a form that is as unified as possible regardless of the channel or capability. And retrieval and webhooks are NOT special — they too are skills usable in a routine (e.g. `@retrieve_events` checks a specific dataset with a specific instruction; a webhook can be invoked at any point in a routine)."

> Design source of truth: `specs/094-unified-skills/research.md` (current-state evidence with path:line, the capability-type vs. instance model, invocation mode, and rejected alternatives). This spec MUST stay consistent with it.

## Framing

Today an agent's capabilities are a stack of unrelated settings cards (MCP / email / Slack / contact / webhook-exports / retrieval), each with its own shape, its own API, and its own degree of "skill-ness". Some are named, routine-callable things; others are buried toggles. There is no single answer to "what does this agent know how to do" and no single way to add a new capability.

This feature makes **one model**: a **capability type** is a kind of action (`retrieve`, `mcp_tool`, `email`, `slack_post`, `webhook_call`, `notify`); a **skill** is a *named, configured instance* of a capability type. Every skill has the same shape — name, capability, target (a connection/dataset), inputs (each **bound** to a fixed value or **exposed** for runtime collection), declared outcomes, an **invocation mode**, and an enabled flag — and every skill is referenceable from a routine by `@name`.

Crucially, **nothing is special**. The agent's grounding answer is just a `retrieve` skill whose invocation mode is "default answer"; `@retrieve_events` is a second `retrieve` skill scoped to a dataset with its own instruction. A webhook call is a skill an author can drop anywhere in a routine. The backend already proves the model — the `agent_skills` spine unifies MCP/email/Slack/webhook today; this feature completes it (adds `retrieve` and `notify`, an invocation-mode property, a capability registry) and surfaces it as **one Skills list with one "Add new skill" form**.

This is **substrate consolidation, not a new channel**: most of the runtime (spine, dispatcher, executors) exists. The load-bearing change is bringing retrieval onto the spine as named instances and introducing the capability-type registry that lets one route and one form serve every capability without knowing each kind.

## User Scenarios & Testing *(mandatory)*

Stories are sliced so each is an independently shippable increment. Priorities: first unify what is already on the spine behind one surface (proves the form + CRUD + connection/skill split), then bring retrieval onto the model (the keystone that makes the claim true), then fold the remaining outliers, then widen invocation.

### User Story 1 - One Skills surface with "Add new skill" for the capabilities already on the spine (Priority: P1)

An author opens an agent's **Skills** tab and sees a single list of that agent's named skills (each showing its name, capability, target, and enabled state), with one **"Add new skill"** button. Adding a skill opens **one unified form**: choose a capability (MCP tool, email, Slack post, webhook call — whichever has a connection available), choose the connected target, give the skill a name, configure each input as **bound** or **exposed**, declare outcomes, and save. The skill is immediately referenceable from a routine by `@name`. Connecting an integration (MCP server, email account, Slack app, webhook destination) is a **separate** step, not part of the skill form.

**Why this priority**: This delivers the whole "add new skill, unified form" value end-to-end over the four capabilities already on the `agent_skills` spine, with no data-model change to runtime behavior. It proves the keystones — the unified CRUD endpoint, the capability-type registry that drives the form, and the connection/skill separation — in one demoable slice and immediately retires three bespoke cards.

**Independent Test**: With MCP/email/Slack/webhook connections present, create one skill of each capability through the single form; verify each is persisted on the `agent_skills` spine with the correct kind/target/config, appears in one unified list, is returned by one `GET /agents/{id}/skills`, and is invocable from a routine by its `@name` exactly as before. Verify the form offers only capabilities whose connection exists, and that creating a skill never creates or edits a connection.

**Acceptance Scenarios**:

1. **Given** an agent with at least one connected integration, **When** the author opens the Skills tab, **Then** they see one list of named skills and one "Add new skill" button — not separate per-channel cards.
2. **Given** the "Add new skill" form, **When** the author picks a capability, **Then** the form shows that capability's connectable targets and its input set, and renders each input with a bound/exposed choice — using the same layout for every capability.
3. **Given** a capability whose integration is not connected, **When** the author opens the form, **Then** that capability is shown as unavailable with a pointer to connect it, and cannot be selected.
4. **Given** a saved skill, **When** an author references its `@name` from a routine tool step, **Then** it resolves and executes through the existing dispatcher/executor unchanged.
5. **Given** an existing MCP/email/Slack/webhook skill created before this change, **When** the unified list loads, **Then** it appears with the correct capability, target, and config (no data migration loss).
6. **Given** the skill form, **When** the author configures inputs, **Then** they cannot edit connection credentials from the form (connection management is a separate surface).

---

### User Story 2 - Retrieval is a named skill capability, with the grounding answer as its default instance (Priority: P2)

An author can create named `retrieve` skills — e.g. `@retrieve_events` scoped to a specific dataset/source-scope with a specific instruction — and reference them from routines, alongside the agent's ordinary grounded answer. The ordinary grounded answer is itself a `retrieve` skill: the one instance whose **invocation mode is "default answer"**. Existing per-agent retrieval tuning (instruction, strategy, topK, rerank, suggested questions, metadata rules, source scope) is migrated into that default instance with no behavior change.

**Why this priority**: This is the keystone that makes "everything is a skill" actually true instead of half-true, and it is the owner's headline example (`@retrieve_events`). It requires bringing retrieval onto the spine as multiple named instances and introducing the **invocation mode** property so the default grounding answer and named retrieve skills coexist without special-casing.

**Independent Test**: Migrate an agent whose retrieval tuning lives in `skill_settings['retrieval.answer']` and verify a single `retrieve` skill exists on the spine with `invocation_mode = default_answer` carrying the same config, and that the agent's ordinary grounded answers are byte-for-byte equivalent to before (same retrieval behavior). Then create a second `retrieve` skill `@retrieve_events` scoped to one dataset with an instruction, reference it from a routine, and verify it retrieves only within that scope using that instruction and returns a structured found/empty outcome the routine can branch on. Verify at most one `default_answer` retrieve skill can exist per agent.

**Acceptance Scenarios**:

1. **Given** an agent with existing retrieval settings, **When** the unified model loads, **Then** those settings are represented as exactly one `retrieve` skill marked "default answer", and the agent's grounded answers are unchanged.
2. **Given** the Skills form, **When** an author adds a `retrieve` skill, **Then** they can name it, choose a source scope/dataset, set an instruction and the per-field retrieval tuning, and choose its invocation mode.
3. **Given** a routine step referencing `@retrieve_events`, **When** it runs, **Then** retrieval is restricted to that skill's scope and uses its instruction, and the step receives a typed found/empty outcome.
4. **Given** an agent, **When** an author tries to mark a second `retrieve` skill as "default answer", **Then** the system prevents it (at most one default-answer instance).
5. **Given** the default-answer retrieve skill, **When** an author edits its tuning, **Then** it behaves like today's retrieval settings (same fields, same inheritance of workspace defaults; `similarityThreshold` remains system-only).

---

### User Story 3 - Invocation mode is explicit on every skill (Priority: P2)

Every skill declares **how it fires**: `default_answer` (the turn's implicit answer path — at most one per agent), `routine_named` (only via `@name` in a routine), or `agent_selectable` (the agent may choose it autonomously during a turn). The mode is shown and editable in the unified form and governs runtime selection.

**Why this priority**: Invocation mode is the mechanism that lets retrieval-as-skill (US2) preserve grounding behavior, and it gives authors precise control over which skills the agent may pick on its own vs. only when a routine calls them. It ships with/just after US2 because US2 depends on the `default_answer` mode existing.

**Independent Test**: Create three retrieve/webhook skills with the three modes; verify the `default_answer` one runs as the implicit answer when no routine is active, the `routine_named` one runs only when `@name`d (never auto-selected), and the `agent_selectable` one is eligible for autonomous selection. Verify a capability that does not support a mode (per the registry) cannot be assigned it.

**Acceptance Scenarios**:

1. **Given** any skill, **When** it is created/edited, **Then** the author selects an invocation mode from those the capability supports.
2. **Given** a `routine_named` skill, **When** a turn runs without a routine invoking it, **Then** the agent does not select it autonomously.
3. **Given** an `agent_selectable` skill, **When** a turn runs, **Then** it is eligible for autonomous selection alongside other selectable skills.
4. **Given** an agent with a `default_answer` retrieve skill, **When** a normal (non-routine) turn runs, **Then** that skill produces the grounded answer.

---

### User Story 4 - Contact/escalate and routine-terminal webhook fold into the model (Priority: P3)

The "Contact requests" public-chat affordance becomes a `notify` skill (delivery to recipients/webhook, message exposed), and the standalone "Webhook exports" routine-terminal toggle is reconciled into a `webhook_call` skill invoked at routine completion. After this, the Skills tab has **no** bespoke capability cards left — only the unified list plus genuinely non-skill agent appearance settings (citations, theme, link UTM).

**Why this priority**: Folds the last special cases so the model is complete and the UI is fully consolidated. It is last because contact and webhook-exports carry existing public-chat / routine-terminal behavior that must be preserved during migration, which is riskier than the additive earlier slices.

**Independent Test**: Migrate an agent with contact-requests enabled and verify a `notify` skill exists carrying the same recipients/webhook delivery, the public-chat "contact a human" affordance still appears and still delivers to the same destinations, and disabling the skill hides the affordance. Separately, migrate an agent with webhook-exports enabled and verify routine completion still exports to the same destination via a `webhook_call` skill, with no duplicate or lost export.

**Acceptance Scenarios**:

1. **Given** an agent with contact requests enabled, **When** the model migrates, **Then** a `notify` skill carries the same recipient emails and webhook, and the public-chat contact affordance behaves identically.
2. **Given** the `notify` skill is disabled, **When** a visitor uses public chat, **Then** the contact affordance is not shown.
3. **Given** an agent with webhook exports enabled, **When** a published routine completes, **Then** the completion export is delivered to the same destination exactly once.
4. **Given** the migration, **When** the Skills tab loads, **Then** the only non-skill controls remaining are agent appearance settings (citations, theme, link UTM); all capabilities are skills in one list.

### Edge Cases

- **Capability with no connection**: the form must show it as unavailable (not hidden silently in a way that confuses), with a path to connect — never a half-filled skill bound to a missing target.
- **Connection deleted while skills reference it**: dependent skills must surface as "needs reconnection" and degrade safely at runtime (no crash); deletion must warn about dependents.
- **Skill name collision**: `@name` is unique per agent across all capabilities (the spine already enforces `UNIQUE (agent_id, skill_name)`); the form must validate before save and the name must be a valid routine identifier.
- **More than one `default_answer`**: must be impossible to persist; existing agents must yield exactly one after migration.
- **Discovered vs. static inputs**: MCP inputs come from tool discovery (may be unavailable if the server is down); the form must handle "couldn't discover" without blocking other capabilities.
- **Outcome vocabulary**: outcomes are structured enums declared by the capability/tool, never inferred from English text (multilingual safety).
- **Routine referencing a disabled/deleted skill**: must resolve to a clear authoring-time warning and a safe runtime outcome, not a 500.
- **Legacy per-kind API clients** (existing SDK/MCP/frontend callers) during cutover: must not break while the unified endpoint lands.

## Non-Goals

- **New capability *types*** beyond consolidating what exists (`retrieve`, `mcp_tool`, `email`, `slack_post`, `webhook_call`, `notify`). Adding e.g. a calendar or SMS capability is future work — the point here is the registry that makes that a one-entry addition.
- **Connection/integration management redesign.** Connections stay where they are (OAuth, credentials, MCP server CRUD); this feature only *separates* them from skill authoring and consumes them.
- **Changing routine authoring UX** beyond skills resolving by `@name` (already supported). The routine canvas/token-doc work is its own track.
- **Cross-agent or workspace-level shared skills.** Skills remain per-agent (bound to per-agent or workspace connections) as today.
- **Agent autonomous tool-use redesign.** `agent_selectable` reuses the existing skill-selection path; this feature does not add a new ReAct/agentic loop.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - *Capability registry (new seam):* a single registry where each capability type declares its target kind + target enumeration, its input schema source (static vs. discovered), its outcome vocabulary, its executor adapter, and its supported invocation modes. It is the one place that knows "what a capability is". Default wiring lives in `backend/src/app/composition/`; the capability descriptors/domain live in `modules/skills` (or `modules/<capability>` for capability-specific schema). It serves **both** runtime resolution and authoring (form descriptor).
  - *Persistence:* the existing `agent_skills` spine, extended with `kind ∈ {retrieve, notify}` and an `invocation_mode` column. Retrieval migrates off `agents.skill_settings['retrieval.answer']` JSONB onto the spine.
  - *Transport:* one CRUD module — `GET/POST/PATCH/DELETE /agents/{id}/skills` + `GET /agents/{id}/skill-capabilities` (registry projection). The route assembles and validates; it MUST NOT contain per-capability branching — it delegates to the registry.
  - *Orchestration/runtime:* the existing `skillDispatcher` + `SkillExecutorRegistry` + per-kind resolvers/executors stay. A `retrieve` resolver/executor must allow **named, scoped instances** (not just the singleton built-in), and a `notify` executor backs contact/escalate.
  - *Frontend:* one `SkillList` + one data-driven `SkillForm` that renders from the capability descriptor; one API adapter replacing `api-external-skills` / `api-customer-email` / `api-slack-skills`.
- **Encapsulation Rule**:
  - The conversation engine and routine runner MUST remain unaware of capability specifics — they resolve a `SkillDefinition` by name and dispatch via the executor port (as today).
  - The CRUD route and the `SkillForm` MUST stay capability-neutral: no `if kind === 'slack'` branches. Per-capability knowledge lives only in the registry/executor.
  - `SkillWebApiClient`s / connection stores MUST NOT learn about skills; skills bind to them, not the reverse.
- **New Seams Required**:
  - **Capability-type registry** (descriptor + executor adapter + invocation modes + form schema source) — the keystone.
  - `agent_skills.invocation_mode` column + `kind` extension (`retrieve`, `notify`); retrieval migration.
  - Unified `agentSkills` CRUD + `skill-capabilities` descriptor endpoint; per-kind routes become thin shims or are removed at cutover (decide in plan).
  - A `retrieve` routine-skill resolver/executor that supports multiple named, source-scoped instances (generalizing today's singleton built-in).
  - A `notify` executor (contact/escalate) and reconciliation of routine-terminal webhook-export into a `webhook_call` skill.
  - Frontend: `SkillForm` (data-driven from descriptor), `SkillList`, unified API adapter.
- **Anti-Goals**:
  - Do NOT put per-capability branching in the CRUD route or the form — that just relocates the god-card into a god-route/god-form. Branch only inside the registry/executors.
  - Do NOT leave retrieval as a JSONB singleton (that keeps `@retrieve_events` impossible and the model half-true).
  - Do NOT encode outcomes/routing/intent with English keyword lists; outcomes are structured enums from the capability/tool.
  - Do NOT merge connection management into the skill form.
  - Do NOT regress existing MCP/email/Slack/webhook/retrieval runtime behavior; consolidation MUST be behavior-preserving except where a slice explicitly adds the new ability.
  - Do NOT hard-code conversational copy for contact/escalate or decline messages.

## Requirements *(mandatory)*

### Functional Requirements

**Unified model & authoring**
- **FR-001**: The system MUST represent every agent capability (`retrieve`, `mcp_tool`, `email`, `slack_post`, `webhook_call`, `notify`) as a named skill instance on the `agent_skills` spine with a common shape: name, capability/kind, target, inputs (bound or exposed), declared outcomes, invocation mode, enabled.
- **FR-002**: The system MUST expose one list endpoint (`GET /agents/{id}/skills`) returning all of an agent's skills uniformly, and one create/update/delete surface for skills, replacing the per-kind endpoint families (legacy routes MAY remain as shims during cutover).
- **FR-003**: The system MUST expose a capability descriptor (`GET /agents/{id}/skill-capabilities`) projecting the capability registry: for each capability type, its connectable targets, its input schema (static or discovered), its outcome vocabulary, and its supported invocation modes — sufficient to render the unified form without capability-specific frontend code.
- **FR-004**: Authors MUST be able to create a skill of any capability whose connection/target exists, through one form: pick capability → pick target → name it → set each input bound or exposed → declare outcomes → choose invocation mode → enable. Capabilities without an available connection MUST be shown as unavailable, not selectable.
- **FR-005**: Skill `@name` MUST be unique per agent across all capabilities and MUST be a valid routine reference identifier; the system MUST validate before persist.
- **FR-006**: Every enabled skill MUST be referenceable from a routine tool step by `@name` and resolve/execute through the existing dispatcher and executor for its capability, unchanged.
- **FR-007**: Connection/integration management MUST remain a separate surface; the skill form MUST NOT create or edit connection credentials.

**Retrieval as a capability**
- **FR-008**: The system MUST model retrieval as a `retrieve` capability with named instances, each bound to a source scope/dataset with its own instruction and per-field tuning (the fields exposed today, with `similarityThreshold` remaining system-only).
- **FR-009**: The system MUST migrate each agent's existing `skill_settings['retrieval.answer']` configuration into exactly one `retrieve` skill with `invocation_mode = default_answer`, preserving current grounding behavior with no observable change.
- **FR-010**: Authors MUST be able to create additional `retrieve` skills (e.g. `@retrieve_events`) scoped to a dataset with an instruction; when invoked from a routine, retrieval MUST be restricted to that scope and use that instruction, returning a structured found/empty outcome.

**Invocation mode**
- **FR-011**: Every skill MUST carry an invocation mode ∈ {`default_answer`, `routine_named`, `agent_selectable`}; the form MUST offer only the modes the capability supports.
- **FR-012**: At most one skill per agent MUST be `default_answer`; the system MUST prevent persisting a second.
- **FR-013**: A `routine_named` skill MUST NOT be autonomously selected by the agent; a `default_answer` skill MUST run as the implicit answer path on non-routine turns; an `agent_selectable` skill MUST be eligible for autonomous selection.

**Outliers folded in**
- **FR-014**: The contact/escalate capability MUST be modeled as a `notify` skill carrying the existing delivery configuration (recipient emails + optional webhook); the public-chat "contact a human" affordance MUST be driven by that skill's enabled state and deliver to the same destinations.
- **FR-015**: The standalone "Webhook exports" toggle MUST be fully folded into the unified model as a `webhook_call` skill invoked at routine completion (no separate completion-export concept remains). Migration MUST be behavior-preserving: each agent with webhook exports enabled MUST yield a `webhook_call` skill bound to its existing destination, and routine completion exports MUST continue to reach that destination exactly once. This is sliced last (US4) to protect existing export behavior during cutover.
- **FR-016**: After consolidation, the Skills tab MUST present one unified skill list; the only non-skill controls remaining MUST be agent appearance settings (citation display, theme/branding, link UTM). Suggested-questions MUST be a setting on the `retrieve` skill, not a standalone card.

**Migration, safety & docs**
- **FR-017**: All migrations (retrieval JSONB → spine; contact/webhook-export → skills) MUST be behavior-preserving and reversible-by-data-shape (no loss); existing skills created before this feature MUST load correctly in the unified list.
- **FR-018**: When a skill's connection/target is missing or revoked, the skill MUST surface as "needs reconnection" and degrade safely at runtime (no crash); deleting a connection MUST warn about dependent skills.
- **FR-019**: Outcomes and capability behavior MUST be expressed as structured enums/metadata, never via English keyword lists or by parsing generated text.
- **FR-020**: The system MUST emit logs/metrics/traces for skill create/update/delete and for capability-descriptor resolution using identities and counts only — never credentials, message text, retrieved content, or tokens. New runtime paths (named retrieve instances, notify executor) MUST be observable.
- **FR-021**: Product-surface documentation (the Skills authoring guide, settings docs, SDK/MCP references for the skills API, and any routine docs referencing skills) MUST be added/updated in the same change.

### Key Entities *(include if feature involves data)*

- **Capability Type**: a registry entry describing a kind of action (`retrieve`, `mcp_tool`, `email`, `slack_post`, `webhook_call`, `notify`) — its target kind + enumeration, input schema source (static/discovered), outcome vocabulary, executor adapter, and supported invocation modes. Not persisted per-agent; it is the registry the form and runtime both read.
- **Skill**: a named, configured instance of a capability type, persisted on the `agent_skills` spine — `name` (`@mention`, unique per agent), `kind`, `target_type`/`target_id`, `config` (bound inputs, exposed inputs, outcome map, capability-specific settings), `invocation_mode`, `enabled`.
- **Connection / Target**: an existing workspace- or agent-scoped integration (MCP connection, email connection, Slack installation, webhook destination) or a retrieval source scope/dataset, that a skill binds to. Managed on its own surface.
- **Input Binding**: per input, either **bound** (author-fixed value) or **exposed** (collected at runtime, optionally bound to a routine slot) — the shape already used by MCP/email/Slack skills, now uniform across capabilities.
- **Invocation Mode**: `default_answer` | `routine_named` | `agent_selectable`, governing how/whether a skill fires.
- **Default-answer retrieve skill**: the single `retrieve` instance per agent carrying the migrated grounding configuration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An author can add any capability (MCP/email/Slack/webhook/retrieve/notify) through **one** "Add new skill" form; the number of distinct per-capability authoring forms drops from 6 to 1.
- **SC-002**: All of an agent's capabilities are returned by **one** `GET /agents/{id}/skills`; the three separate skill API adapters on the frontend are reduced to one.
- **SC-003**: An author can create `@retrieve_events` scoped to a dataset with an instruction and invoke it from a routine; the routine receives only in-scope results — verified by a routine integration test.
- **SC-004**: After migration, 100% of agents have exactly one `default_answer` retrieve skill, and grounded-answer output is unchanged versus pre-migration on a regression eval set (0 behavioral diffs).
- **SC-005**: Adding a new capability type in the future requires one registry entry + one executor and **zero** changes to the CRUD route or the skill form (verified by a design/test fixture adding a stub capability).
- **SC-006**: The Skills tab contains zero bespoke per-capability cards after US4; only the unified list + agent appearance settings remain.
- **SC-007**: No regression in existing MCP/email/Slack/webhook/retrieval runtime behavior (existing suites green) and no credentials/message content/retrieved chunks appear in logs or API responses (verified by inspection/tests).
- **SC-008**: Contact and routine-terminal webhook behavior is preserved across migration: the public-chat contact affordance and routine completion exports reach the same destinations with no loss or duplication (verified by migration tests).
