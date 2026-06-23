# Data Model: Unified Skill Model

This model **completes the consolidation the `agent_skills` spine started**. The spine (migrations 099/101/108) already unifies `external_mcp`, `customer_email`, `webhook`, and `slack` skills as named, configured, enabled rows. This feature:

1. adds an **`invocation_mode`** property to every skill,
2. adds two kinds — **`retrieve`** and **`notify`** — and migrates retrieval (off `agents.skill_settings` JSONB) and contact/webhook-export (off `assistantBehaviorSettings`) onto the spine,
3. introduces a **capability-type registry** (not a table) that both the runtime and the authoring form read.

The result: one row shape for every capability, one CRUD surface, one form.

## Layering

```text
CapabilityTypeRegistry (code, not a table)
  declares per capability: targetKind · input schema source · outcome vocabulary
                           · supported invocation modes · executor adapter
        │ projected to authoring form (GET /skill-capabilities) AND runtime resolution
        ▼
Agent
  └── agent_skills (the spine — one row per named skill)
        ├── kind=retrieve       target=source_scope        → RetrieveExecutor
        ├── kind=mcp_tool*       target=mcp_connection      → McpSkillExecutor
        ├── kind=email*          target=integration_conn    → EmailSkillExecutor
        ├── kind=slack_post*     target=integration_conn    → SlackEscalationExecutor
        ├── kind=webhook_call*   target=webhook_destination → WebhookSkillExecutor
        └── kind=notify          target=notify_delivery     → NotifyExecutor
        (* existing kinds; names normalized — see "Kind naming" below)
```

## agent_skills (existing spine — extended)

Existing columns (from 099/101): `id`, `agent_id`, `workspace_id`, `skill_name`, `kind`, `target_type`, `target_id`, `config JSONB`, `enabled`, `created_at`, `updated_at`; `UNIQUE (agent_id, skill_name)`.

**New column:**

| Field | Type | Notes |
|---|---|---|
| invocation_mode | text | CHECK in (`default_answer`, `routine_named`, `agent_selectable`). Governs how/whether the skill fires. |

**Kind extension:** the `kind` CHECK constraint gains `retrieve` and `notify`.

**Kind naming:** the spec uses capability-type names (`mcp_tool`, `email`, `slack_post`, `webhook_call`). The spine today stores `external_mcp`, `customer_email`, `webhook`, `slack`. To avoid a churny rename of stable data, **keep the existing stored kind values** and map them to capability-type identifiers in the registry (`external_mcp ↔ mcp_tool`, `customer_email ↔ email`, `slack ↔ slack_post`, `webhook ↔ webhook_call`). New kinds are stored as `retrieve` and `notify`. The registry is the single mapping point; the API/form speak capability-type identifiers, persistence keeps its values. (Plan may choose to alias rather than migrate kind strings.)

**Invariants:**
- `UNIQUE (agent_id, skill_name)` (existing) — `skill_name` is the routine `@mention` id; must be a valid identifier.
- **At most one `default_answer` per agent**: `CREATE UNIQUE INDEX agent_skills_one_default_answer ON agent_skills (agent_id) WHERE invocation_mode = 'default_answer'`.
- Each capability declares which invocation modes it supports; the service rejects unsupported (capability, mode) pairs.

**Backfill for existing rows:** all current `external_mcp`/`customer_email`/`webhook`/`slack` skills get `invocation_mode = 'routine_named'` (they are referenced by `@name` from routines today; this preserves behavior — they are not autonomously selected).

## CapabilityType registry (NEW — code, not persisted)

The keystone seam. One descriptor per capability type:

| Field | Meaning |
|---|---|
| `id` | capability-type identifier (`retrieve`, `mcp_tool`, `email`, `slack_post`, `webhook_call`, `notify`) |
| `storedKind` | the `agent_skills.kind` value persisted for this capability |
| `targetKind` | the connection/target type it binds to (`source_scope`, `mcp_connection`, `integration_connection`, `webhook_destination`, `notify_delivery`) |
| `enumerateTargets(agentId, workspaceId)` | available targets for the form (e.g. connected MCP servers, email connections, source scopes) |
| `inputSchema` | static input schema **or** `'discovered'` (MCP tool discovery). Drives the form's bound/exposed panel. |
| `outcomeVocabulary` | the structured outcome enums this capability can return (never English-text inferred) |
| `supportedInvocationModes` | subset of {`default_answer`, `routine_named`, `agent_selectable`} |
| `executorAdapter` | key in `SkillExecutorRegistry` (existing for the four kinds; new for `retrieve`, `notify`) |
| `validateConfig(config)` | Zod validation of bound/exposed/outcome config for this capability |

Supported invocation modes by capability (initial):

| Capability | default_answer | routine_named | agent_selectable |
|---|---|---|---|
| `retrieve` | ✅ (the grounding answer) | ✅ (`@retrieve_events`) | ✅ |
| `mcp_tool` | — | ✅ | ✅ |
| `email` | — | ✅ | ✅ |
| `slack_post` | — | ✅ | ✅ |
| `webhook_call` | — | ✅ | ✅ |
| `notify` | — | ✅ | ✅ |

**Default wiring** lives in `backend/src/app/composition/` (register each descriptor + bind its `executorAdapter`); per-capability schema/outcomes live in `modules/skills/capabilities/*` (and `modules/retrieval` for retrieve semantics).

## config JSONB by capability

Uniform envelope (already used by MCP/email/slack): `{ boundInputs, exposedInputs, outcomes/outcomeMap, ...capabilitySettings }`.

- **retrieve**: `{ sourceScope: 'all' | {sourceIds: uuid[]}, instruction?, retrievalStrategy?, vectorTopK?, rerankEnabled?, rerankTopK?, queryRewriteEnabled?, semanticRewriteInstructions?, lexicalRewriteInstructions?, suggestedQuestionsEnabled?, suggestedQuestionsCount?, metadataRules?, exposedInputs: { query } }`. `similarityThreshold` is **excluded** (system-only, model-coupled). `target_type='source_scope'`, `target_id=null` (scope in config).
- **mcp_tool**: `{ toolName, boundParams, exposedParams, declaredOutcomes?, outcomeMap? }` (unchanged). `target=mcp_connection`.
- **email**: `{ mode: 'draft'|'send', boundInputs, exposedInputs, outcomes }` (unchanged). `target=integration_connection`.
- **slack_post**: `{ boundInputs:{channelId?}, exposedInputs:{text,threadTs?}, outcomes }` (unchanged). `target=integration_connection` (slack installation behind it).
- **webhook_call**: `{ boundInputs:{url?,headers?}, exposedInputs:{payload...}, outcomes }`. `target=webhook_destination`.
- **notify**: `{ delivery: { recipientEmails: string[], webhook?: { url } }, exposedInputs:{ message }, outcomes }`. `target_type='notify_delivery'`, `target_id=null` (delivery in config) — or reuse a webhook_destination + email recipients.

## Migration 1 — Retrieval onto the spine (behavior-preserving) [US2]

Today: per-agent retrieval lives in `agents.skill_settings['retrieval.answer']` (074) plus `assistantBehaviorSettings.retrievalEnabled` / `.sourceScope` / `.suggestedQuestions*`.

Migrate each agent to **one** `retrieve` skill row:
- `skill_name = 'answer'` (reserved default name; valid identifier; unique per agent),
- `kind='retrieve'`, `invocation_mode='default_answer'`,
- `enabled = retrievalEnabled` (default true if unset),
- `config` = the merged retrieval override fields + `sourceScope` + `exposedInputs:{query}`.

Runtime: the default-answer turn path resolves this row instead of reading `skill_settings`. **Inheritance of workspace retrieval defaults is preserved** (unset fields fall back to system/workspace defaults exactly as today). `agents.skill_settings['retrieval.answer']` is read-migrated and then no longer the source of truth (kept for one release as a fallback read, or dropped in the same migration with a backfill — plan decides). Regression: grounded-answer output must be unchanged on an eval set (SC-004).

Named retrieve instances (`@retrieve_events`) are additional `retrieve` rows with `invocation_mode='routine_named'`, their own `sourceScope` + `instruction`, resolved by the retrieve routine-skill resolver (generalizing today's singleton `RetrievalAnswerSkillExecutor` built-in).

## Migration 2 — Contact → notify (behavior-preserving) [US4]

Today: `assistantBehaviorSettings.contactRequestsEnabled` + `contactRequestDelivery { recipientEmails, webhook }`.

Migrate each agent with contact enabled to a `notify` skill:
- `skill_name='contact_human'`, `kind='notify'`, `invocation_mode='routine_named'`,
- `enabled = contactRequestsEnabled`,
- `config.delivery = contactRequestDelivery`, `config.exposedInputs={message,email}`.

The public-chat "contact a human" affordance is driven by this skill's `enabled` state and delivers to `config.delivery` (same destinations). Surface invocation (the button) is orthogonal to `invocation_mode` (which governs turn-level selection); the button invokes the skill directly. No hard-coded conversational copy.

## Migration 3 — Webhook exports → webhook_call (behavior-preserving) [US4]

Today: `assistantBehaviorSettings.webhookExportsEnabled` + workspace webhook destinations (086).

Migrate each agent with exports enabled to a `webhook_call` skill bound to its destination:
- `skill_name='completion_export'` (or per-destination), `kind='webhook'` (stored)/`webhook_call` (capability), `invocation_mode='routine_named'`,
- `enabled = webhookExportsEnabled`, `target=webhook_destination`.

Routine completion invokes this skill at terminal state (replacing the standalone toggle). Exactly-once delivery preserved via the existing outbox idempotency (FR-015/SC-008). The standalone toggle is removed.

## What stays OUT of the spine (agent appearance settings)

`citationDisplayEnabled`, `assistantLinkUtmEnabled`, `theme`/`branding` remain on `assistantBehaviorSettings`. `suggestedQuestionsEnabled`/`Count` move into the `retrieve` skill config (a setting on the default-answer instance), not a standalone card.

## Relationship Summary

```text
CapabilityTypeRegistry (code) ──projects──> GET /skill-capabilities (form descriptor)
        │ binds executorAdapter
        ▼
Agent ── agent_skills (spine; +invocation_mode; kinds retrieve/notify added) ──@name──> routines
        ├── retrieve(default_answer)  ← migrated from skill_settings['retrieval.answer']
        ├── retrieve(routine_named)   ← @retrieve_events (new ability)
        ├── mcp_tool / email / slack_post / webhook_call  (existing rows; +invocation_mode=routine_named)
        ├── notify                    ← migrated from contactRequestDelivery
        └── webhook_call(completion)  ← migrated from webhookExportsEnabled
Runtime: skillDispatcher resolve-by-name → SkillExecutorRegistry[executorAdapter] (unchanged seam)
```
