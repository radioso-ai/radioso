# Feature Specification: Per-Agent Skill Settings (Retrieval First)

**Feature Branch**: `071-per-agent-skill-settings`
**Created**: 2026-06-04
**Status**: Draft
**Input**: Design discussion — "why is retrieval configured outside per-agent skill setup?" Design note: `.context/per-agent-skill-settings.md`.

**Scope Note**: Today retrieval is configured at the **workspace** level (`retrieval_settings`, one record per workspace, surfaced via a settings page + `get/update_retrieval_settings` REST and MCP tools), even though retrieval is already a per-agent-toggleable skill (`retrieval.answer`, `agent.retrievalEnabled`) whose contract **already declares** a settings-override slot (`RetrievalSettingsOverride`). This feature makes retrieval configuration a **per-agent skill setting** and retires the workspace retrieval layer entirely: the **knowledge base owns ingestion only**; the **agent owns retrieval behavior**; **defaults come from the system / embedding-model layer**, not a hand-tuned workspace record.

It introduces one general seam — `agent.skillSettings`, keyed by skill name, validated by each skill's own `settingsSchema`, resolved `defaults ⊕ agent-override` inherit-by-default — with retrieval as its first consumer. There is **no new "capability" entity** (the kit has no first-class `Capability`; the two retrieval skills carry distinct per-skill tags and share no config owner). Anti-goals: do not keep a workspace retrieval baseline page; do not add a retrieval-specific branch to the turn loop; do not expose model-coupled knobs (`similarityThreshold`) per agent; do not snapshot defaults into agents at runtime (only at migration).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure Retrieval Per Agent (Priority: P1)

As an operator, I want to configure an agent's retrieval behavior — answer instructions, query rewrite, suggested questions, strategy, and (advanced) tuning — on that agent, so two assistants over the same corpus can behave differently without touching a shared workspace setting. Fields I don't set inherit the system default.

**Why this priority**: This is the headline value and the MVP. It delivers per-agent retrieval immediately, on top of the existing default source, before any deletion/migration work.

**Independent Test**: Give agent A a retrieval override (e.g. custom answer instruction + `queryRewriteEnabled`); leave agent B's `skillSettings` empty. Run the same query against both. Assert A's behavior reflects its override and B's reflects the defaults, and that B required zero configuration.

**Acceptance Scenarios**:

1. **Given** an agent with a retrieval override set on one field, **When** a turn runs, **Then** that field uses the override and every unset field uses the system/model default.
2. **Given** an agent with empty `skillSettings`, **When** a turn runs, **Then** retrieval behaves entirely on defaults (full inherit) and the answer is grounded.
3. **Given** an override is written, **When** it is persisted and reloaded, **Then** it is validated against the retrieval skill's own `settingsSchema` and rejected if invalid, with no bespoke per-skill validator added.

---

### User Story 2 - Zero-Config Agent Retrieves By Default (Priority: P1)

As someone creating a new assistant, I want retrieval **on by default** and working with no configuration, so a freshly created agent answers from the knowledge base out of the box.

**Why this priority**: The added configuration surface must never become setup friction; a new agent must be a working grounded agent.

**Independent Test**: Create a new agent, configure nothing, ask a question the corpus can answer. Assert it returns a grounded answer (retrieval enabled, defaults inherited).

**Acceptance Scenarios**:

1. **Given** a newly created agent, **When** no retrieval settings are touched, **Then** `retrievalEnabled` is true and `skillSettings` is empty, and grounded answering works.
2. **Given** the agent Skills tab, **When** an operator opens retrieval, **Then** inherited values are shown as coming from the default (not blank), so overriding is opt-in per field.

---

### User Story 3 - One Home For "Which Docs" (Priority: P2)

As an operator, I want an agent's document scope and metadata rules configured together on the agent, so "which docs can this assistant retrieve" stops being split across the agent, the workspace, and per-call filters.

**Why this priority**: Resolves an existing three-way split (`agent.sourceScope` top-level / workspace `metadataRules` / per-call `metadataFilter`) and is a prerequisite for deleting the workspace record (US4).

**Independent Test**: On one agent, set both `sourceScope` and a `metadataRules` boost; on another, set neither. Assert each agent retrieves according to its own consolidated doc-scope settings and the two do not interfere.

**Acceptance Scenarios**:

1. **Given** `sourceScope` folded into the retrieval skill settings, **When** an agent restricts to selected sources, **Then** only those sources are retrieved for that agent.
2. **Given** per-agent `metadataRules`, **When** a rule boosts/filters, **Then** it applies only to that agent's turns.

---

### User Story 4 - Knowledge Base Owns Ingestion Only (Priority: P2)

As a maintainer, I want the workspace retrieval-settings record, page, and `get/update_retrieval_settings` REST + MCP surfaces removed, with retrieval defaults relocated to the system/model layer, so the knowledge base owns ingestion only and there is a single ownership story.

**Why this priority**: This is the cleanup the whole change is for. It depends on US1/US3 (the per-agent home must exist first) and carries the migration and governance risks.

**Independent Test**: After migration, for a fixed set of previously-tuned workspaces, retrieval behavior (answer/citations/scope) for each agent matches pre-migration output. Confirm the workspace retrieval page and endpoints/MCP tools no longer exist.

**Acceptance Scenarios**:

1. **Given** a workspace that had tuned retrieval values, **When** migration runs, **Then** each of its agents carries those tuned values as overrides (only where they differ from the new defaults) and produces the same retrieval behavior as before.
2. **Given** a workspace with default (untuned) retrieval, **When** migration runs, **Then** its agents get empty `skillSettings` and the effective retrieval behavior is unchanged.
3. **Given** the removed surfaces, **When** a client calls `get_retrieval_settings`/`update_retrieval_settings` or opens the old page, **Then** the surface is gone (clear deprecation/removal response), and the knowledge base exposes ingestion settings only.

---

### User Story 5 - Workspace Retrieval Governance Is Preserved If It Exists (Priority: P3, Conditional)

As an administrator, if my organization relies on a workspace-wide retrieval **filter** (e.g. "never surface documents tagged confidential") that all agents must honor and cannot override, I want that guardrail preserved as an admin-owned policy after the workspace tuning page is removed.

**Why this priority**: Conditional on the governance audit (see Gates). If no live workspace uses `metadataRules` as cross-agent governance, this story is dropped and the delete is clean. If any do, the guardrail must not evaporate.

**Independent Test**: With a workspace-level non-overridable filter policy configured, an agent that tries to override it still cannot surface the filtered documents.

**Acceptance Scenarios**:

1. **Given** an admin-owned workspace retrieval policy filter, **When** any agent retrieves, **Then** the filter applies and the agent cannot disable it via its own `skillSettings`.

---

### Edge Cases

- **Default drift**: an agent sets field X explicitly, then the system default for X later changes. The agent keeps its explicit value; only unset fields follow the new default. (Confirm this is intended.)
- **similarityThreshold parity**: the old workspace default constant may differ from the new model-owned default. Migration MUST preserve each workspace's *effective* threshold so behavior does not silently change for untuned workspaces.
- **Stale metadata field**: an override `metadataRules` references a field that no longer exists after an ingestion change — behavior MUST degrade safely (rule no-ops), not error the turn.
- **Both sources set at migration**: an agent already has `sourceScope` while the workspace has `metadataRules` — migration MUST fold both into the agent's consolidated home without conflict.
- **`retrieval.search` untouched**: it is not agent-facing (`supportedCallers` excludes `assistant`); it MUST NOT gain a per-agent toggle or settings surface.
- **Deprecated MCP clients**: external clients still calling the removed tools after release MUST get a clear, documented removal error, not a silent failure.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use the **centrally-configured** default provider/model, resolved in one place via `resolveLlmConfig` (`backend/src/shared/infra/llm/providerConfig.ts`, env `LLM_PROVIDER` + per-capability overrides; currently GPT-5.2). This feature MUST NOT introduce another hard-coded provider/model default site — retrieval system defaults read provider/model from that resolver (see FR-015).
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The **agent module** owns the opaque `skillSettings` persistence (transport via the agent PATCH surface). The **skills module** owns each skill's `settingsSchema` and is the sole validator/source-of-truth for override shape. The **retrieval module** owns the override shape, its system/model defaults, and the `defaults ⊕ override` resolution. **Composition** (`backend/src/app/composition/`) assembles the resolver and hands effective settings to the skill dispatcher. The **conversation engine** stays capability-neutral.
- **Encapsulation Rule**: `ChatService` / the turn loop MUST NOT gain a retrieval-specific branch — it already passes a settings override into the skill; only the *source* of that override changes. The settings/knowledge-base module MUST NOT own any retrieval query-time config after this change.
- **New Seams Required**: (1) `agent.skillSettings: Record<SkillName, unknown>` opaque map — mirror of the existing `surfaceSettings.extensions` registry pattern (`agents/domain.ts`); (2) a narrow `SkillSettingsResolver` port `(skill, defaults, agentOverride) -> effectiveSettings`; (3) a system/embedding-model **retrieval defaults provider** replacing the workspace record.
- **Anti-Goals**: No "capability" entity or registry. No retained workspace retrieval baseline page. No runtime snapshotting of defaults into agents (migration only). No per-agent `similarityThreshold`. No new branch in the engine/`ChatService`. No bespoke per-skill validators (reuse `settingsSchema`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The agent MUST carry an opaque `skillSettings` map keyed by skill name; each entry MUST be validated against that skill's own `settingsSchema`.
- **FR-002**: The turn MUST resolve effective skill settings as `defaults ⊕ agent-override`, inherit-by-default (an absent override field resolves to the default).
- **FR-003**: Per-agent overrides MUST be read/written via the **agent** surface (PATCH), not via workspace-scoped retrieval endpoints.
- **FR-004**: Retrieval defaults MUST be owned by the system / embedding-model layer. `similarityThreshold` MUST be model-coupled and MUST NOT be an agent-configurable field.
- **FR-005**: Retrieval MUST be enabled by default for new agents, and an empty `skillSettings` MUST yield working grounded retrieval with no configuration.
- **FR-006**: `sourceScope` MUST move into the retrieval skill settings and `metadataRules` MUST become per-agent, so "which docs" has a single per-agent home; per-call `metadataFilter` (API callers) is unaffected.
- **FR-007**: The workspace `retrieval_settings` record, its settings page, and the `get_retrieval_settings` / `update_retrieval_settings` REST endpoints and MCP tools MUST be removed.
- **FR-008**: The knowledge base MUST retain ingestion settings only (chunking, parsing, embedding model, connectors) and own no retrieval/query-time config.
- **FR-009**: Migration MUST snapshot each workspace's tuned retrieval values into every agent's `skillSettings`, only where they differ from the new defaults; untuned workspaces' agents MUST migrate to empty `skillSettings`. Effective behavior MUST be preserved (including effective `similarityThreshold`).
- **FR-010**: A **governance audit** MUST establish whether any workspace `metadataRules` function as cross-agent filter governance (`effect: filter` + `always_on` + `enabled`). **RESOLVED (2026-06-04)**: audit run against the Radioso DB (419 workspaces / 421 agents) found **0** governance-shaped filters — `metadataRules` holds exactly 1 rule total, a `boost` (preference), 0 filters. ⇒ FR-011/US5 are **out of active scope**. The audit query (research.md) MUST be re-run against production immediately before the destructive migration (G1) as a final guard.
- **FR-011** *(contingency, not built)*: If a future production re-run finds governance usage, an **admin-owned workspace retrieval policy** (filter only, applied to all agents, non-overridable by `skillSettings`) would be required. Per FR-010 this is currently **not built**.
- **FR-012**: The agent Skills tab MUST render retrieval config from the skill's `settingsSchema`: behavioral knobs surfaced, operational knobs (`vectorTopK`, `rerank*`) under an "advanced" affordance, inherited values shown as "from default"; model-coupled knobs not shown.
- **FR-013**: SDK and MCP contracts MUST be updated to reflect the removed surfaces; the change MUST be reviewed against worker/AMQP/contract impact per the message-queue review rule.
- **FR-014**: The duplicated `customInstruction` / `suggestedQuestionsEnabled` fields (currently in both the workspace retrieval record and agent behavior) MUST resolve to a single per-agent home; no third copy.
- **FR-015**: The system retrieval defaults (FR-004) MUST source any LLM provider/model from the central `resolveLlmConfig` (`LLM_PROVIDER` + per-capability env), not a new hard-coded default. Removing the workspace record MUST NOT re-introduce a provider/model default elsewhere.

### Key Entities *(include if feature involves data)*

- **AgentSkillSettings**: opaque map on the agent, key = skill name, value = that skill's override (validated by its `settingsSchema`). Empty = full inherit.
- **RetrievalSettingsOverride (extended)**: the existing retrieval skill settings shape, extended to include `sourceScope` and `metadataRules`; all fields optional (absent = inherit).
- **SystemRetrievalDefaults**: system/embedding-model-owned defaults replacing the deleted workspace record; `similarityThreshold` is model-derived.
- **WorkspaceRetrievalPolicy** *(conditional, FR-011)*: admin-owned, filter-only, non-overridable cross-agent guardrail.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of newly created agents return grounded answers with zero retrieval configuration (retrieval default-on, full inherit).
- **SC-002**: Two agents in one workspace can be configured with different retrieval behavior (e.g. different doc scope and answer instructions) and each turn behaves strictly per its own agent's settings.
- **SC-003**: After migration, retrieval behavior for every previously-tuned workspace's agents matches pre-migration output (parity; no silent reset), verified on a fixed regression set.
- **SC-004**: No workspace-level retrieval configuration surface remains — the page, REST endpoints, and MCP tools are absent — and the knowledge base exposes ingestion settings only.
- **SC-005**: Adding a second configurable skill requires no change to the resolver/seam, demonstrated by configuring a throwaway non-retrieval skill through the same path.
- **SC-006**: "Which docs can this agent retrieve" is configurable in exactly one place per agent.

## Open Decisions / Gates

- **G1 — Governance audit — RESOLVED (2026-06-04)**: ran against the Radioso DB (419 workspaces / 421 agents). **0 governance-shaped filter rules**; `metadataRules` total = 1 (a single `boost`). ⇒ **clean delete (US4)**; US5/FR-011 dropped from scope. One residual guard: re-run the query (research.md) against **production** immediately before the destructive migration, since the audited DB may not be prod.
- **G2 — Default-drift semantics — RESOLVED (2026-06-04, confirmed)**: explicit per-agent overrides do **not** drift when a system default later changes; only unset (absent) fields follow the new default. Inherit-by-null.
- **G3 — Slicing**: US1+US2 are the shippable MVP and can land while the workspace record still exists as the default source; US3 then consolidates doc-scoping; US4 deletes the workspace layer with migration. (US5 dropped per G1.)
