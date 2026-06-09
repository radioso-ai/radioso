# Tasks: US4 — Remove the Workspace Retrieval Layer (071)

Executes spec 071 **US4 / FR-007, FR-008, FR-009, FR-013, FR-014, FR-015**. US1–US3 already
shipped (PR #608): per-agent `agents.skill_settings`, `SkillSettingsResolver`, the Skills-tab
retrieval UI, per-agent `metadataRules`. This file removes the workspace retrieval **base layer**
and relocates defaults to the system/model layer, preserving behavior via a one-time migration.

**Branch**: `remove-workspace-retrieval-knobs` → PR to `main`.
**Discipline**: backend TDD (failing test first); frontend Playwright for visible journeys.
**Parity is the bar**: tuned workspaces must answer identically post-migration (SC-003).

---

## Phase A — System retrieval defaults provider + rewire resolution base (keystone)

Today `RetrievalContextStageService.execute` reads the **workspace** record as the merge base
(`retrievalSettingsService.getForWorkspace`). Replace that base with a workspace-agnostic
**system defaults** source. Untuned workspaces are unaffected (base was already defaults); tuned
workspaces reach parity via Phase B's migration in the same release.

- [ ] A1. Add a `RetrievalDefaultsProvider` port returning the system retrieval defaults as the
  resolver base (no DB read, no `workspaceId`). Source `similarityThreshold` from
  `RETRIEVAL_BEHAVIOR.defaultSimilarityThreshold`; any provider/model from `resolveLlmConfig`
  (FR-015 — no new hard-coded default site). Owned by the retrieval module; assembled in
  `backend/src/app/composition/`.
- [ ] A2. Rewire `retrievalContextStage` to merge `systemDefaults ⊕ agentOverride ⊕ perTurnOverride`
  via the existing `SkillSettingsResolver`; stop calling `getForWorkspace` for the base. Keep
  `workspaceId` threaded for downstream queries (it comes from the request, not the settings row).
- [ ] A3. Do **not** delete `retrievalSettingsService`/repository yet — eval snapshot + runner still
  read it until Phase C. Keep everything compiling and green.
- [ ] A4. Tests (TDD): defaults base + agent override merge; unset fields inherit system default;
  per-turn override still wins; untuned-workspace parity (effective settings unchanged).

## Phase B — One-time migration snapshot (FR-009, D6) — MUST land before Phase C drops columns

- [ ] B1. Re-run the G1 governance audit query (research.md) against the target DB; record result.
  Abort the destructive path if any `effect:filter + always_on + enabled` rule appears.
- [ ] B2. Migration: for each `retrieval_settings` row, for each agent in that workspace, write
  `agents.skill_settings["retrieval.answer"]` from the field-by-field diff vs new defaults
  (only non-default fields; see data-model.md mapping). Untuned workspace ⇒ agents stay `{}`.
  Run inside a transaction; idempotent (skip keys already present).
- [ ] B3. `similarity_threshold` parity guard: it is NOT a per-agent field. If a tuned row has a
  non-default threshold, the migration MUST fail loudly with the workspace id (so we handle it
  explicitly) rather than silently dropping it. (Audit expects 0 such rows.)
- [ ] B4. Tests: tuned row → expected override; untuned → `{}`; threshold-divergent row → migration
  raises; re-run idempotency.

## Phase C — Remove REST + service/repo retrieval ownership + drop columns (FR-007, FR-008)

- [ ] C1. Remove `GET/PUT /settings/retrieval` routes + `presentRetrievalSettings`.
- [ ] C2. Remove `retrievalSettingsService` retrieval read/write + repo `findByWorkspaceId`/`upsert`
  retrieval paths. **Keep** ingestion (`chunking_strategy`) and LLM-capability (migration 059)
  reads — those are not retrieval.
- [ ] C3. Migration: drop retrieval/query-time columns + `attribute_controls` from
  `retrieval_settings` (`query_rewrite_enabled`, `rerank_enabled`, `vector_top_k`,
  `similarity_threshold`, `rerank_top_k`, `custom_instruction`, `attribute_controls`). Keep the
  table (ingestion + LLM-capability columns remain).
- [ ] C4. Collapse the duplicated `customInstruction` / `suggestedQuestions*` to the single
  per-agent home (FR-014); no third copy left in workspace behavior.
- [ ] C5. Regenerate `backend/openapi.{yaml,json}` from the code-first registry. TDD: contract test
  asserts the retrieval-settings paths are gone.

## Phase D — MCP surface (FR-013)

- [ ] D1. Remove `get_retrieval_settings` / `update_retrieval_settings` tools + `TOOL_CATALOG` /
  `capabilityPolicy` entries + adapter methods; update `describe_capabilities`.
- [ ] D2. Old clients calling the removed tools get a clear, documented removal error (not a silent
  failure). Update smoke tests (`smoke:all`).

## Phase E — TypeScript SDK (FR-013)

- [ ] E1. `pnpm run sync` + regen; drop retrieval-settings methods/types; build + tests green.
- [ ] E2. Changelog + migration note for SDK consumers.

## Phase F — Frontend

- [ ] F1. Remove the workspace retrieval settings page/panel + its nav entry; remove
  `settingsApi.getRetrievalSettings/updateRetrievalSettings`. Keep the agent Skills-tab retrieval
  UI (US1–US3) intact.
- [ ] F2. Remove/redirect any link into the old page; ensure no dead nav. Playwright: agent Skills
  retrieval journey still passes; old workspace retrieval page no longer reachable.

## Phase G — Docs (read `docs/document-writer-prompt.md` first)

- [ ] G1. `readme.md`, `docs/` retrieval + settings + MCP + SDK pages, `docs-portal/content/*`,
  product settings docs. Reframe: knowledge base = ingestion only; retrieval = per-agent skill.
- [ ] G2. Update/remove the local README brief for any area whose ownership moved.

## Phase H — Contract review + CI + PR

- [ ] H1. Message-queue/contract review: confirm no worker/AMQP payload carried the removed fields
  (rewrite/rerank/embedding config resolves via `resolveLlmConfig`); update queue tests/docs if so.
- [ ] H2. `pnpm run ci:local -- origin/main` (or `--all` for breadth); paste result in PR body.
- [ ] H3. PR to `main` with migration/contract-removal notes + parity evidence (SC-003/SC-004).

## Ordering / parallelism

A → B → C are strictly sequential (B before C drops columns). After C, D / E / F can run in
parallel; G / H last. Keep on one branch + shared dev DB (do not parallelize migration-touching
work across worktrees).
