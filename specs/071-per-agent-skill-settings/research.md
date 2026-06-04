# Research: Per-Agent Skill Settings (071)

Phase 0 decisions and unknowns for `spec.md`. Source design note: `.context/per-agent-skill-settings.md`.

## Decisions (resolved)

- **D1 — Seam shape.** `agent.skillSettings: Record<SkillName, unknown>` — an opaque per-agent map keyed
  by skill name, each value validated by that skill's own `settingsSchema`. Mirrors the existing
  `surfaceSettings.extensions` registry pattern (`backend/src/modules/agents/domain.ts:118`,
  `normalizeSurfaceExtensions` at `:384`). **Rejected**: a first-class "capability" entity — the kit has
  no `Capability` type, the two retrieval skills carry *distinct* per-skill tags
  (`retrieval.answer` / `retrieval.search`) and share no config owner.
- **D2 — Override carrier.** Per-agent overrides read/written via the **agent PATCH** surface (option A),
  not by extending workspace-scoped `get/update_retrieval_settings`. Keeps the agent the single locus.
- **D3 — Defaults home.** Retrieval defaults move to a **system/embedding-model layer**, replacing the
  workspace record. `similarityThreshold` is **model-coupled** (already a system constant,
  `retrievalSettings.ts:158`) and is not an agent knob. Any LLM provider/model in those defaults comes
  from the central `resolveLlmConfig` (`backend/src/shared/infra/llm/providerConfig.ts`, env
  `LLM_PROVIDER` + per-capability overrides) — **no new hard-coded default site** (FR-015).
- **D4 — `sourceScope` placement.** Fold `sourceScope` into the retrieval skill settings (extend
  `RetrievalSettingsOverride`), alongside per-agent `metadataRules` (option A). Promote to an agent-level
  shared scope only if a second agent-facing retrieval skill ever appears.
- **D5 — Delete the workspace retrieval layer.** Remove the `retrieval_settings` retrieval/query-time
  config, its settings page, the REST `get/update_retrieval_settings` endpoints, and the MCP
  `get_retrieval_settings`/`update_retrieval_settings` tools. Knowledge base keeps ingestion settings
  only. (Note: `retrieval_settings` also currently holds `chunking_strategy` — an *ingestion* field —
  so the table is not necessarily dropped wholesale; the retrieval/query-time columns + JSONB are.)
- **D6 — Migration is the one legitimate snapshot.** Copy each workspace's tuned retrieval values into
  every agent's `skillSettings["retrieval.answer"]`, only where they differ from the new defaults;
  untuned → `{}`. Preserve effective behavior, including effective `similarityThreshold`.

## Unknowns / Gates

- **G1 — Governance audit (BLOCKING for US4 clean-delete vs. US5 carve-out).** Determine whether any
  live workspace uses `metadataRules` as a cross-agent **filter** guardrail (`effect: "filter"` +
  `always_on` + `enabled`) rather than an author boost preference. `metadataRules` persist in the
  `attribute_controls` JSONB of `retrieval_settings` (keyed by `workspace_id`). Ready-to-run query:

  ```sql
  -- Workspaces with at least one enabled, always-on FILTER rule (governance-shaped, not a boost).
  SELECT rs.workspace_id,
         jsonb_array_length(COALESCE(rs.attribute_controls->'metadataRules','[]'::jsonb)) AS total_rules,
         count(*) FILTER (
           WHERE rule->>'effect' = 'filter'
             AND COALESCE(rule->>'triggerMode','always_on') = 'always_on'
             AND COALESCE((rule->>'enabled')::boolean, true) = true
         ) AS governance_filters
  FROM retrieval_settings rs
  LEFT JOIN LATERAL jsonb_array_elements(
    COALESCE(rs.attribute_controls->'metadataRules','[]'::jsonb)
  ) AS rule ON true
  GROUP BY rs.workspace_id, rs.attribute_controls
  HAVING count(*) FILTER (
           WHERE rule->>'effect' = 'filter'
             AND COALESCE(rule->>'triggerMode','always_on') = 'always_on'
             AND COALESCE((rule->>'enabled')::boolean, true) = true
         ) > 0;
  ```

  Run via the Docker Radioso DB (`postgres://postgres:postgres@localhost:5432/radioso`):
  `docker compose up -d db` then
  `docker compose exec -T db psql -U postgres -d radioso -f <query>`.
  **RESULT (2026-06-04)** — ran against the Radioso DB (`radioso_radioso_postgres_data` volume):
  **419 workspaces, 421 agents, 16 customized `retrieval_settings` rows.** `metadataRules` across the
  whole dataset = **1 rule total**, in 1 workspace, and it is a **`boost`** with `match_turn` trigger
  (an author preference). **Filter rules = 0; governance-shaped (always_on + enabled + filter) = 0.**
  ⇒ **No cross-agent governance usage.** Decision: **clean delete (US4)**; FR-011/US5 dropped. Residual
  guard: re-run the query against **production** immediately before the destructive migration (the
  audited DB may not be prod). Migration sizing from the same probe: of the 16 customized rows, 4 have
  rewrite on, 3 rerank on, 3 non-default `topK`, 3 non-default `rerankTopK`, 2 a custom instruction — so
  the per-agent snapshot is small and low-risk (the other 403 workspaces migrate to `{}`).

- **G2 — Default-drift semantics — RESOLVED (confirmed).** An explicit per-agent override does **not**
  drift when a system default later changes; only unset (absent) fields follow the new default
  (inherit-by-null). This is the intended merge semantics for `SkillSettingsResolver`.

## Notes for planning

- `retrieval.answer.settingsSchema = RetrievalSettingsOverride` already exists and its steps resolve
  `settings_default ⊕ override` — the engine already threads an override into the skill; only the
  *source* of that override changes. No new engine branch (anti-goal).
- `customInstruction` / `suggestedQuestionsEnabled` are duplicated today between `RetrievalSettingsRecord`
  and `AgentBehaviorSettings`; deleting the workspace record collapses them to one per-agent home (FR-014).
