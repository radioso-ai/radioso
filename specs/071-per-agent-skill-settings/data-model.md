# Data Model: Per-Agent Skill Settings (071)

## New / changed entities

### Agent: `skillSettings` (new)

- **Persistence**: `agents.skill_settings JSONB NOT NULL DEFAULT '{}'` (new column on the existing
  `agents` table, migration `048_agents.sql` lineage).
- **Domain**: `ConversationAgent.skillSettings: Record<string, unknown>` — opaque, keyed by
  `SkillDefinition.name`. Empty `{}` = full inherit. Normalized per-key like
  `surfaceSettings.extensions` (`backend/src/modules/agents/domain.ts`): known keys validated by the
  owning skill's `settingsSchema`, unknown keys passed through opaquely on read.
- **Transport**: read/written via the agent PATCH surface only (FR-003).

### `RetrievalSettingsOverride` (extended)

The retrieval skill's existing `settingsSchema` (`retrieval.answer/generated.contract.json`), extended.
**All fields optional → absent = inherit the system/model default.**

| Field | Class | Notes |
|---|---|---|
| `customInstruction` | behavioral | canonical home (resolves the duplication, FR-014) |
| `semanticRewriteInstructions` | behavioral | |
| `lexicalRewriteInstructions` | behavioral | |
| `queryRewriteEnabled` | behavioral | |
| `suggestedQuestionsEnabled` / `suggestedQuestionsCount` | behavioral | canonical home (FR-014) |
| `retrievalStrategy` | behavioral | `fixed` \| `reasoning` \| `auto` |
| `metadataRules` | behavioral (doc scoping) | now per-agent |
| ~~`sourceScope`~~ | doc scoping | **NOT in the override (option B, revised)** — stays in dedicated per-agent storage + workspace-membership validation; surfaced in the unified "which docs" UI, not folded into JSONB |
| `vectorTopK` | operational (advanced) | system default unless set |
| `rerankEnabled` / `rerankTopK` | operational (advanced) | system default unless set |
| ~~`similarityThreshold`~~ | model-coupled | **removed from the override** — owned by system/model layer, FR-004 |

### `SystemRetrievalDefaults` (new, replaces workspace record)

- The default layer for resolution. Owned by the retrieval module (defaults) + system/embedding-model
  layer (model-coupled values). `similarityThreshold` is model-derived (already
  `RETRIEVAL_BEHAVIOR.defaultSimilarityThreshold`). Provider/model (if any) come from `resolveLlmConfig`
  (FR-015). Not user-editable; no per-workspace row.

### `WorkspaceRetrievalPolicy` (conditional — only if G1 finds governance usage)

- Admin-owned, **filter-only**, applied to all agents, **non-overridable** by `skillSettings`. Narrow:
  not the deleted tuning page. Built only if FR-010's audit is positive.

## Resolution

```
effective = SystemRetrievalDefaults
            ⊕ agent.skillSettings["retrieval.answer"]   // inherit-by-default (undefined ⇒ default)
            ⊕ (WorkspaceRetrievalPolicy filters)         // conditional, non-overridable, applied last
```

- Validation = the skill's own `settingsSchema` (no bespoke per-skill validator).
- `similarityThreshold` is injected from the system/model layer, never from the override.
- Resolver assembled in `backend/src/app/composition/`; engine stays capability-neutral.

## Removed (US4 / FR-007, FR-008)

- `retrieval_settings` **retrieval/query-time** columns + `attribute_controls` JSONB:
  `query_rewrite_enabled`, `rerank_enabled`, `vector_top_k`, `similarity_threshold`, `rerank_top_k`,
  `custom_instruction`, `attribute_controls` (holds `metadataRules`, rewrite instructions, suggested
  questions, strategy). Migrated out first (D6), then dropped.
- **Retained on the workspace as ingestion**: `chunking_strategy` (and any other ingestion columns) stay
  — they are knowledge-base/ingestion config, not retrieval. (So the *table* may persist for ingestion;
  only retrieval columns/JSONB are removed.)
- REST `GET/PUT .../retrieval-settings`; MCP `get_retrieval_settings` / `update_retrieval_settings`.
- Frontend workspace retrieval settings page.

## Migration (D6 / FR-009)

For each `retrieval_settings` row (`workspace_id`), for each agent in that workspace, build
`skillSettings["retrieval.answer"]` from the **field-by-field diff vs. new defaults**:

| Source (workspace `retrieval_settings`) | Target (`agent.skillSettings["retrieval.answer"]`) | Rule |
|---|---|---|
| `custom_instruction` | `customInstruction` | copy if non-empty / non-default |
| `query_rewrite_enabled` | `queryRewriteEnabled` | copy if ≠ default |
| `attribute_controls.semanticRewriteInstructions` | `semanticRewriteInstructions` | copy if ≠ default |
| `attribute_controls.lexicalRewriteInstructions` | `lexicalRewriteInstructions` | copy if ≠ default |
| `attribute_controls.suggestedQuestions*` | `suggestedQuestions*` | copy if ≠ default |
| `attribute_controls.metadataRules` | `metadataRules` | copy if non-empty |
| `attribute_controls.retrievalStrategy` | `retrievalStrategy` | copy if ≠ default |
| `vector_top_k` | `vectorTopK` | copy if ≠ default |
| `rerank_enabled` / `rerank_top_k` | `rerankEnabled` / `rerankTopK` | copy if ≠ default |
| `similarity_threshold` | — | **not copied to override**; if ≠ new model default, preserve effective value via the system/model layer (parity, see Edge Cases) |
| `agent.sourceScope` | — | **not migrated** (option B): stays in its dedicated per-agent storage |

Untuned workspace (all defaults) ⇒ agents migrate to `{}`. The migration is the **only** place values are
snapshotted per-agent; at runtime, unset fields inherit.
