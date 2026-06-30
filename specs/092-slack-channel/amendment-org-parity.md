# Amendment: Slack install belongs to the organization; channels route to agents via a channel-scoped skill

**Status:** Proposed · **Amends:** `data-model.md` (D-B) and migration `107_slack_keystone.sql`
**Trigger:** Connecting the same Slack workspace from two Radioso workspaces in one organization fails with a duplicate error.

## Problem

The as-built model scopes a Slack installation to a single **workspace**
(`slack_installations.workspace_id`) and keys agent selection one-per-installation
(`slack_channel_bindings UNIQUE (installation_id)`, the D-B v1 deferral). But the tenant a Slack
workspace actually corresponds to is the **organization**, not one workspace:

- One shared Slack app → exactly **one bot user per Slack workspace** → inbound events arrive
  keyed only by `team_id`. That identity is genuinely 1:1 with *a company*.
- In Radioso the company is the **account** (`accounts` row; "organization" in EE speak), which
  owns many `workspaces` via `workspaces.account_id`. True in OSS, not just EE.

So `team_id`'s global `UNIQUE` is **correct** — there is one bot identity. The defect is the
*owner column*: a single org-level identity is pinned to one workspace, so sibling workspaces
under the same account collide on the global `team_id` unique.

> Do NOT "fix" this with `UNIQUE (workspace_id, team_id)` — that lets two rows exist but breaks
> inbound routing, which is keyed on `team_id` alone.

## The parity

| Slack | Radioso | Rationale |
|---|---|---|
| Slack workspace (`team_id`) | **account / organization** | one shared app, one bot, events keyed by `team_id` — one identity per company |
| Slack channel (`channel_id`) | **agent (in a workspace)** | the natural dispatch key *inside* the org (#sales → agent X / workspace A) |

This **reverses D-B**: per-Slack-channel agent routing is no longer "future" — it is the
mechanism that makes one Slack workspace serve an org's many workspaces/agents.

## Two layers — keep them separate

1. **Installation = an org-level resource.** "Add to Slack" / OAuth produces one bot identity +
   one credential per Slack workspace, owned by the **account**. A workspace clicking "Add to
   Slack" *establishes or reuses* the org install; it does not create a per-workspace connection.
   The install knows only Slack identity + credential — nothing about agents, channels, or routing.

2. **The unit of work = a channel-scoped agent skill.** What an agent actually does in Slack is
   answer in / post to specific channels. This is already half-built: outbound posting is an
   `agent_skills` row (`kind='slack'`, `target_id → slack_installation`). Inbound answering is the
   odd one out — a flat `slack_channel_bindings` row. We unify them.

## Schema changes

### 1. `slack_installations` — re-home from workspace to account

- Replace `workspace_id` with **`account_id`** (FK → `accounts`, `ON DELETE CASCADE`).
- `team_id` stays globally `UNIQUE` (one bot per Slack workspace).
- Add **`default_answerer_skill_id`** (FK → the agent skill that answers DMs and unbound channels;
  see Routing). This is **mandatory once installed** — see "The mandatory default."

Indexes: `team_id` UNIQUE; `(account_id)`; `(connection_id)`.

> `integration_connections.workspace_id` (the credential/lifecycle spine) is unaffected — the
> OAuth connection still belongs to whichever workspace performed the install. Only the *Slack
> routing detail* moves up to the account.

### 2. Channel presence becomes a skill role (replaces `slack_channel_bindings`)

An agent's Slack presence is a **channel-scoped skill** on the existing `agent_skills` spine,
binding `(org install, channel, agent)`. Inbound-answering and outbound-posting are **roles** on
that skill, not separate tables. This folds the inbound binding into the same `kind='slack'` skill
that already carries outbound posting.

| Field (on the slack skill detail) | Notes |
|---|---|
| `installation_id` | FK → `slack_installations` (the org install / identity) |
| `agent_id` / `workspace_id` | the answering+posting agent and its workspace (via `agent_skills`) |
| `channel_id` | text, nullable — the Slack channel this skill operates in; **null = default** |
| `is_answerer` | bool — does this skill answer inbound mentions/DMs in `channel_id`? |
| `escalation_channel_id` | text nullable — gap escalation target (unchanged) |

**Cardinality — inbound and outbound are not symmetric; the model must not pretend they are:**
- **Inbound answering is exclusive.** One bot → one reply ⇒ at most one agent may answer a given
  channel. Enforce `UNIQUE (installation_id, channel_id) WHERE is_answerer` — a partial unique
  index across all agents' slack skills.
- **Outbound posting is not exclusive.** Many agents may post into the same channel; no constraint.

### 3. `slack_channel_bindings` is removed

Its rows migrate into channel-scoped slack skills with `channel_id = NULL`, `is_answerer = true`
(each current single-binding install becomes one default answerer skill on the same agent).

## Routing — how `@radioso` picks an agent

The channel is the routing key. The mention text is **never** read to choose an agent (no
content-based routing). An `@mention` arrives with `team_id` + `channel_id` (+ `thread_ts`):

1. **`team_id` → installation → account.** Unknown team → ignore.
2. **`channel_id` → channel answerer.** The slack skill with `(installation_id, channel_id,
   is_answerer=true)` → run that agent, in that workspace.
3. **No channel answerer → install default.** `slack_installations.default_answerer_skill_id`
   (the `channel_id = NULL` answerer skill) → run the default agent.
4. **No default → degrade visibly.** Skip or post "no agent is configured for this channel."

DMs (`message.im`, no routable channel) resolve straight to the default answerer (step 3).
`slack_conversation_links.slackKey` still encodes `team_id`/`channel_id`/`thread_ts`; only
agent/workspace selection changes.

## The mandatory default

A mention in a channel with no answerer and no default goes **nowhere** — this is exactly the prod
incident where the bot sat silent on `@mention` because no answering binding existed. Therefore:

- **Every install MUST have a default answerer skill** (`default_answerer_skill_id` non-null once
  installed). The connect flow sets it — the connecting agent becomes the default — surfaced in the
  UI as "Default agent for DMs and unlisted channels."
- Per-channel answerer skills are then optional overrides on top of the default.

## Migration / backfill

1. Add `slack_installations.account_id`; backfill from `workspace_id`'s `workspaces.account_id`;
   then drop `workspace_id` (or keep nullable for one release).
2. For each `slack_channel_bindings` row, create a `kind='slack'` skill on `answering_agent_id`
   with `channel_id = NULL`, `is_answerer = true`, carrying `escalation_channel_id`; set the
   install's `default_answerer_skill_id` to it. Drop `slack_channel_bindings`.
3. Add `channel_id` + `is_answerer` to the slack skill detail; add the partial unique index.

Behavior-preserving for every current single-workspace install: it becomes an org-scoped install
with one default answerer skill pointing at the same agent.

## What does NOT change

- Single shared Slack app, one webhook URL, `team_id`-keyed inbound, `event_id` dedupe.
- Credential/token storage (`integration_oauth_connections`), outbox `slack.post`, gap-escalation
  policy, routine `slack` skill execution path.
- `team_id` remains globally unique.

## Spec deltas to fold back

- `data-model.md` D-B: change from "per-channel routing is future" to "per-channel routing binds a
  Slack channel to an agent (channel-scoped slack skill) within the owning organization."
- `data-model.md` SlackInstallation: `account_id` owner + mandatory `default_answerer_skill_id`.
  Remove the standalone SlackChannelBinding table; describe inbound answering as an `is_answerer`
  role on the `kind='slack'` agent skill, with the partial-unique answerer constraint.
- `spec.md`: multi-tenancy statement → "one Slack workspace ⇒ one Radioso **organization**;
  channels route to agents within it." Add an FR for the mandatory default answerer and the
  channel→agent resolution order.
