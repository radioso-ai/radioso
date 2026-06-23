# Research: Unified Skill Model

**Feature**: `094-unified-skills`
**Status**: Design source of truth for `spec.md` — the spec MUST stay consistent with the decisions here.

This note captures the current state (with path:line evidence), the design debate that produced the model, and the decisions/rejected alternatives that the spec depends on.

## Problem

The per-agent **Skills** settings tab is subpar. It is a vertical stack of unrelated, hand-rolled cards — "External MCP skills", "Email skills", "Slack skills", "Contact requests", "Webhook exports", "Retrieval answers" — each with its own type, its own API adapter, its own form shape, and (in the email card) live bugs. There is no single "what does this agent know how to do" surface and no single "Add new skill" entry point. The skill concept is "kind of declarable but not really": some skills are first-class named, routine-callable things; others are buried toggles.

The owner's framing: **every actionable capability — MCP, email, Slack, webhook, *and retrieval* — should be a named skill that expresses a defined capability and is usable from a routine.** Example: `@retrieve_events` is a retrieval skill scoped to a specific dataset with a specific instruction; a webhook can be invoked at any point in a routine. Nothing is "special".

## Current state (evidence)

### Backend is already unified at the data layer

- **Spine**: `agent_skills` table — `backend/src/db/migrations/099_agent_skills_spine.sql`, generalized in `101_agent_skills_generic_targets.sql`. Columns: `skill_name`, `kind`, `target_type`, `target_id`, `config JSONB`, `enabled`. `UNIQUE (agent_id, skill_name)`; `skill_name` IS the routine `@mention` id.
- **Kinds today**: `external_mcp`, `customer_email`, `webhook`, `slack` (`108_slack_agent_skill_kind.sql`).
- **Unified contract**: `SkillDefinition` / `SkillOutcome` / `ConversationRoutineSkillDispatcher` in `packages/conversation-contract` (re-exported as `@radioso/skill-contract`). Backend `SkillOwner`/`SkillExecution` in `backend/src/modules/skills/domain.ts`.
- **Dispatch seam**: `backend/src/modules/routines/skillDispatcher.ts` resolves a skill by name via a chain of `RoutineSkillResolver`s (`externalSkills`, `webhookSkills`, `slackSkills`, plus a `StaticRoutineSkillResolver` for built-ins) → looks up an executor in a `SkillExecutorRegistry` keyed by `execution.adapter` → capability-gates → dispatches. Executors: `mcpSkillExecutor`, `webhookSkillExecutor`, `slackEscalationExecutor`.
- **Common config shape** across `external_mcp` / `customer_email` / `slack`: `boundInputs`/`boundParams` (author-fixed) + `exposedInputs`/`exposedParams` (collected at runtime, optionally `slotBinding`) + declared `outcomes`/`outcomeMap` + `enabled`. The pattern is identical; it is just not named once.

### The two outliers

- **Retrieval is NOT on the spine.** It lives in `agents.skill_settings['retrieval.answer']` JSONB (`074_agents_skill_settings.sql`; `backend/src/modules/retrieval/domain/retrievalSkillSettings.ts`), as a **singleton** per agent (the grounding answer). It is dispatched as a built-in via `StaticRoutineSkillResolver` + `RetrievalAnswerSkillExecutor`. There is no way to have a *second*, dataset-scoped retrieve skill.
- **Contact requests** and **webhook exports** live in `assistantBehaviorSettings` (`contactRequestsEnabled` + `contactRequestDelivery`; `webhookExportsEnabled`) — toggles, not named skills. Contact is a public-chat affordance; webhook-exports is a routine-terminal completion export.

### Frontend never unified

`frontend/components/dashboard/settings/workspace-assistant-channels-tab.tsx` (≈1127–1278) renders six bespoke sections: `AssistantExternalSkillsSection`, `AssistantEmailSkillsSection`, `AssistantSlackSkillsSection`, plus inline Contact/Webhook/Retrieval. Three separate API adapters (`api-external-skills`, `api-customer-email`, `api-slack-skills`), three separate types (`ExternalSkillDefinition`, `CustomerEmailSkillDefinition`, `SlackSkillDefinition`), each re-deriving the same bound/expose/outcomes shape. The MCP card also mixes **connection setup** (connect a server) with **skill authoring** (turn a tool into a named skill) in one place.

## The model (decisions)

### D1 — Capability *type* vs. named skill *instance*

There are **capability types** (a small registry) and a **skill** is a *named, configured instance* of one:

| Capability type | Target | Bound (author-fixed) | Exposed (runtime) | Outcomes |
|---|---|---|---|---|
| `retrieve` | a source scope / dataset | instruction, strategy, topK, rerank… | the query (+ filters) | found / empty |
| `mcp_tool` | an MCP connection + tool | fixed params | tool params | declared by tool / author |
| `email` | an email connection | recipient, mode(draft\|send) | subject, body | sent / failed |
| `slack_post` | a Slack installation + channel | channel | text, thread | posted / failed |
| `webhook_call` | a webhook destination | URL, headers | payload fields | 2xx / error |
| `notify` (contact/escalate) | one or more delivery channels | recipients | message | delivered / failed |

A **skill** = `name` + `capability` + `target` + `inputs(bound|exposed)` + `outcomes` + `invocationMode` + `enabled`. This single shape already describes the four spine kinds; it extends cleanly to `retrieve` and `notify`. Today's "Retrieval answers" card is exactly **the default-configured `retrieve` instance** (scope=all, no instruction); `@retrieve_events` is a second `retrieve` instance.

### D2 — Invocation mode (the rigor that keeps retrieval-as-skill from losing behavior)

Each skill declares **how it fires**, as data, not as a special-cased card:

- `default_answer` — runs as the turn's implicit answer path (today's grounding). **At most one per agent.**
- `routine_named` — invoked only by `@name` from a routine step.
- `agent_selectable` — the agent may choose it autonomously during a turn (the existing skill-selection path).

With this field, "the agent's grounding answer" and "`@retrieve_events`" are both `retrieve` skills; one is simply the `default_answer` instance. Nothing is special-cased; behavior is data.

### D3 — Connections are separate from Skills

A **Connection** (MCP server, email account, Slack install, webhook destination) is a workspace-scoped, reusable integration owning credentials/OAuth. A **Skill** is a per-agent named binding *on top of* a connection. The current MCP card conflates the two; the unified model splits them. "Add new skill" only offers capabilities whose connection exists → "Slack is only a Slack skill when Slack is connected" falls out naturally. Connection CRUD stays where it is; only skill authoring unifies.

### D4 — The new seam: a Capability Type registry

The thing that makes "one form, one CRUD endpoint" possible without the route/UI knowing each kind is a **capability-type registry**. Each capability type declares, in one place:

- its **target kind** (which connection type it binds to) and how to enumerate available targets,
- its **input schema** source (static for email/slack/webhook/retrieve; discovered for mcp_tool), so the unified form can render the bound/expose panel data-driven,
- its **outcome vocabulary**,
- its **executor adapter** (already keyed in `SkillExecutorRegistry`),
- the **invocation modes** it supports (e.g. `retrieve` supports all three; `webhook_call` supports routine_named + agent_selectable; `email` typically routine_named).

This registry serves **both** runtime (resolve → execute) **and** authoring (the form/`GET capabilities` descriptor). Adding a future capability = one registry entry + one executor, not a new card and a new endpoint.

### D5 — Unified CRUD + capability descriptor API

Collapse the per-kind endpoint families into one: `GET/POST/PATCH/DELETE /agents/{id}/skills` (mirrors the spine) plus `GET /agents/{id}/skill-capabilities` (the registry projection: available capability types, each with its connectable targets and input schema). The per-kind executors are unchanged; only the authoring/list surface unifies. The legacy per-kind routes can remain as thin shims during migration or be removed once the UI cuts over (decided in plan).

## Decisions on the outliers

- **Retrieval** → migrate the `agents.skill_settings['retrieval.answer']` singleton into a `retrieve`-kind row on the spine with `invocationMode = default_answer`. Per-field tuning becomes the skill's `config`. Authors can then add additional `routine_named` `retrieve` skills scoped to a dataset + instruction (`@retrieve_events`). `similarityThreshold` stays system-only (model-coupled), as today.
- **Contact requests** → a `notify`-kind skill. The public-chat "contact a human" button becomes a surface that invokes this skill; `contactRequestDelivery` (recipients + webhook) becomes the skill target/config. (The button's visibility = the skill being enabled.)
- **Webhook exports (routine-terminal)** → **fold fully** into a `webhook_call` skill invoked at routine completion (owner decision 2026-06-22). The standalone toggle is removed; no distinct completion-export concept remains. Behavior-preserving migration binds each enabled agent's export to a `webhook_call` skill at its existing destination; sliced last (US4) to protect routine-terminal behavior during cutover.

## Explicitly NOT skills (stay as agent appearance/behavior settings)

Pure presentation/UX preferences: citation display, link UTM, theme/branding. Suggested-questions becomes a **setting on the `retrieve` skill**, not its own card.

## Rejected alternatives

- **Keep retrieval/contact/webhook as "behaviors" separate from "callable skills"** (the first proposal). Rejected by the owner: retrieval and webhooks *are* legitimately routine-callable and dataset-scopable; the behaviors/skills split was a false dichotomy. The real axis is **invocation mode** (D2), not skill-vs-behavior.
- **Frontend-only reshuffle** (one component over the existing three endpoints). Rejected: it would leave retrieval off the spine and still singleton, so `@retrieve_events` would remain impossible and the model would stay half-true.
- **One fat `agent_skills.config` with no capability registry**, letting the route/UI branch on `kind`. Rejected: that just relocates the per-kind branching into a god-route and god-form. The capability registry (D4) is what keeps transport/UI capability-neutral.

## Constraints to honor (from CLAUDE.md / constitution)

- TDD on the backend; Playwright for the visible Skills authoring journey; unit tests for the capability registry / form data-derivation logic only.
- No English keyword lists for capability/outcome meaning — outcomes are structured enums declared by the capability/tool.
- No hard-coded conversational copy — runtime assistant strings stay LLM-generated.
- Keep domain rules in `modules/`; the capability registry default wiring is composition (`backend/src/app/composition/`). The CRUD route assembles, it does not own capability logic.
- Docs are product surface: the Skills authoring docs + settings docs update in the same change.
