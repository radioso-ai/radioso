# Data Model: Slack Channel

This model **completes a generalization that feature 089 started**: 089 made the *credential* layer provider-neutral (`integration_oauth_connections`) but left a per-feature *connection* table (`customer_email_connections`). We introduce a provider-neutral **`integration_connections`** spine, fold email into it (behavior-preserving precursor), and add Slack as a second consumer with a thin detail table for its inbound routing key.

Resolves the two previously-open decisions:
- **D-A (generic connection table):** yes — `integration_connections` spine + per-provider detail only where the DB must constrain/index provider data.
- **D-B (multi-agent routing):** one install (one Slack `team_id`) maps to **one answering agent** via the binding row; per-channel agent routing is future, not v1.

## Layering

```text
Workspace
  └── IntegrationOauthConnection        (existing, generic — the credential/token)
        └── IntegrationConnection       (NEW generic spine — lifecycle + display + config)
              ├── (customer_email)       email config in JSONB; no detail table
              └── SlackInstallation      (detail: team_id UNIQUE + routing)
                    ├── SlackChannelBinding  (answering agent + escalation channel)
                    └── (conversations via source_channel="slack")
```

---

## IntegrationConnection (NEW — generic spine)

Provider-neutral "a workspace has a connected, OAuth-backed integration." Owns the connection **lifecycle** shared by every provider; subsumes the lifecycle columns previously on `customer_email_connections`.

| Field | Type | Notes |
|---|---|---|
| id | uuid | Stable reference |
| workspaceId | uuid | Owning workspace |
| oauthConnectionId | uuid | FK → `integration_oauth_connections` (the credential) |
| provider | string | `customer_email_google`, `customer_email_microsoft`, `slack` |
| displayName | text | Operator/admin label |
| status | enum | `authorized`, `disabled`, `needs_reauth`, `error` |
| lastHealthStatus | enum nullable | `ok`, `failed`, `unknown` |
| lastHealthCheckedAt | timestamptz nullable | Health check time |
| lastErrorCode | text nullable | Sanitized reason |
| config | jsonb | Small provider-scoped scalar config (e.g. email sender fields). NOT secrets, NOT routing keys that need indexing. |
| createdAt / updatedAt | timestamptz | |

**State transitions** (carried over from the email connection state machine):
```text
authorized -> disabled | needs_reauth | error
needs_reauth -> authorized            # reauthorization success
disabled -> authorized | needs_reauth # operator re-enables
any -> error
```

**Validation / rules**
- Tokens/secrets live only on `integration_oauth_connections`; never duplicated here, never returned.
- Bounded scope: this table is for **OAuth-backed workspace integrations** only. Webhook destinations (no OAuth) and document connectors (different lifecycle) MUST NOT be folded in.
- Provider-specific data that needs DB-level **uniqueness, indexing, or FKs** does NOT go in `config` — it gets a detail table (see Slack).

**Indexes**: `(workspaceId)`, `(workspaceId, provider)`, `(oauthConnectionId)`.

---

## Customer Email (folded in — precursor refactor, behavior-preserving)

`customer_email_connections` is **removed**; its rows migrate into `integration_connections`:
- lifecycle columns → spine columns (1:1);
- `senderEmail`, `senderName`, `replyToEmail` → `config` JSONB;
- `provider` value preserved (`google_mail`/`microsoft_graph_mail` → mapped to the spine's provider naming).

`EmailSkillDefinition` / `EmailSkillRunActivity` are unchanged except their `connectionId` now references `integration_connections.id`. This refactor lands as its **own PR** with email behavior proven unchanged before any Slack code (see plan Phase R).

---

## SlackInstallation (NEW — Slack detail)

Slack-specific routing that the generic spine cannot hold because `teamId` must be a **unique, fast lookup key for inbound events** (events arrive with only a `team_id`, no workspace).

| Field | Type | Notes |
|---|---|---|
| id | uuid | Stable reference |
| connectionId | uuid | FK → `integration_connections` (the lifecycle/credential) |
| workspaceId | uuid | Denormalized for inbound lookup convenience |
| teamId | text | **UNIQUE** — Slack workspace id; the inbound routing key |
| teamName | text nullable | Display only |
| botUserId | text | The bot's own Slack user id (used for self-loop suppression) |
| createdAt / updatedAt | timestamptz | |

**Indexes**: `teamId` UNIQUE; `(workspaceId)`; `(connectionId)`.

**Rules**
- One installation per Slack `team_id`. Re-install updates the existing row + refreshes the credential.
- `botUserId` is required so inbound filtering can drop the bot's own messages without text inspection.

---

## SlackChannelBinding (NEW — routing config)

Which agent answers, and where gaps escalate. Separated from the installation so routing can change without touching credentials.

| Field | Type | Notes |
|---|---|---|
| id | uuid | Stable reference |
| installationId | uuid | FK → `slack_installations` |
| workspaceId | uuid | Owning workspace |
| answeringAgentId | uuid | FK → agents; the agent that answers inbound DMs/mentions |
| escalationChannelId | text nullable | Slack channel id for automatic gap escalation; null = escalation disabled |
| createdAt / updatedAt | timestamptz | |

**Rules**
- v1: exactly one binding per installation (one install → one answering agent). Per-Slack-channel agent routing is explicitly deferred (D-B).
- `escalationChannelId` null ⇒ automatic gap escalation is a no-op (FR-017 safe-degrade).

---

## Conversation (extended — existing table)

Reuses `conversations.source_channel`; no schema change beyond the identity mapping.

- `source_channel = "slack"`.
- Identity → conversation mapping (D5): DMs are user-scoped per `(team_id, slack_user_id)`; `app_mention` is thread-scoped per `(team_id, channel_id, thread_ts)`. The stable key is stored so successive Slack events resume the same conversation.

| Mapping key | Surface |
|---|---|
| `(teamId, slackUserId)` | DM (`message.im`) — rolling per-user conversation |
| `(teamId, channelId, threadTs)` | channel `@mention` — one conversation per thread |

Stored as a `slack_conversation_links` lookup (key → conversationId) OR conversation metadata; the link table is preferred so inbound lookup is a single indexed read.

### SlackConversationLink (NEW — small lookup)
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| workspaceId | uuid | |
| installationId | uuid | FK |
| slackKey | text | The mapping key above (canonicalized) — **UNIQUE** |
| conversationId | uuid | FK → conversations |
| createdAt / updatedAt | timestamptz | |

---

## SlackInboundEvent (NEW — dedupe / idempotency)

At-most-once turn processing for Slack retries (FR-008).

| Field | Type | Notes |
|---|---|---|
| eventId | text | Slack `event_id` — **PRIMARY KEY** (idempotent insert) |
| teamId | text | For routing/diagnostics |
| receivedAt | timestamptz | |
| status | enum | `received`, `processed`, `skipped` |

**Rules**: insert-on-receipt is the dedupe gate; a duplicate `event_id` short-circuits before a turn runs. Retention: prune rows older than a small window (events are short-lived).

---

## Typed Turn Outcome (NOT a table — contract on the turn result)

The gap-escalation trigger (FR-016/FR-017, research D7) reads a **typed field**, never reply text.

- Required signal: did the turn produce a **grounded answer**? (the existing grounded-answer flag surfaced to the quality view is the source).
- Exposure: `ConnectorChatPort.answer(...)`'s result MUST carry this typed outcome (e.g. `grounded: boolean` / `outcome: "answered" | "no_context"`). If it does not today, the plan adds this narrow field to the connector/turn result — a contract change, not a new store.

---

## Slack Outbox Action (NEW action type on the existing outbox)

One outbound unit on the existing `routine_action_requests` outbox; one handler; two enqueue triggers (FR-017 gap policy, FR-019 routine skill).

- `type`: e.g. `slack.post`
- `payload` (sanitized; no secrets): `{ installationId, channelId, text, threadTs?, conversationRef, kind: "gap_escalation" | "channel_reply" | "routine_post" }`
- `idempotencyKey`: per triggering turn (gap) / per routine step (routine) → prevents duplicate posts (FR-018).
- Handler resolves the installation's credential via the generic connection → oauth row, posts via `SlackWebApiClient`, applies retry/backoff via the dispatcher.

> The **inbound channel reply** may post directly via `SlackWebApiClient` in the turn worker (WhatsApp pattern) OR route through `slack.post` for uniformity. Plan decision (see plan Phase 1): prefer direct post for the reply (latency, in-turn) and the outbox for escalation/routine (reliability, out-of-band). All three use the same client + credential (FR-020).

---

## SlackEscalationSkill (routine path only — agent_skills spine)

A `slack`-kind row on the existing `agent_skills` spine, used **only** for routine-authored posts (FR-019). Not involved in automatic gap escalation.

| Field (on agent_skills + slack detail) | Type | Notes |
|---|---|---|
| skillName | text | Unique within agent; routine identifier |
| kind | enum | `slack` (added to the spine's kind check) |
| installationId / bindingId | uuid | Target install |
| boundParams / exposedParams | jsonb | channel (bound or exposed), text (exposed) |
| enabled | boolean | Allowlist flag |

Executor (`SlackEscalationExecutor`) enqueues a `slack.post` action — the same type/handler as the gap policy.

---

## Relationship Summary

```text
Workspace
  ├── IntegrationOauthConnection            (credential/token; existing)
  │     └── IntegrationConnection           (lifecycle/config; NEW spine)
  │            ├── customer_email (config JSONB) ──> EmailSkillDefinition ──> EmailSkillRunActivity
  │            └── SlackInstallation (teamId UNIQUE, botUserId)
  │                   ├── SlackChannelBinding (answeringAgentId, escalationChannelId)
  │                   ├── SlackConversationLink ──> Conversation (source_channel="slack")
  │                   └── SlackEscalationSkill (agent_skills kind="slack", routine path)
  ├── SlackInboundEvent (dedupe; keyed by Slack event_id)
  └── routine_action_requests (existing outbox) ──> slack.post handler ──> SlackWebApiClient
```
