# Implementation Plan: Slack operator experience

**Branch**: `slack-rich-integration` | **Date**: 2026-06-23 | **Spec**: `specs/095-slack-operator-experience/spec.md`
**Input**: Feature specification from `specs/095-slack-operator-experience/spec.md`

## Summary

Make Slack a real operator console on top of the shipped Slack channel (092) and HITL console (091).
Two capabilities: **act on Slack** (approve/deny a decision; take over / talk-to-customer / hand back
a conversation — all resolved through the *existing* approvals + conversation-ownership services) and
**see Slack in Activity** (typed channel context on the conversation → real Slack badge). The technical
spine is a new **inbound interactivity adapter** (Slack `block_actions`/`view_submission` callbacks,
same signature discipline as the events webhook) plus **interactive Block Kit posting** (a new variant
of the existing `slack.post` outbox action), bridged to the HITL domain by a thin **Slack operator action
resolver** that first maps the Slack user to a Radioso account. Operator notifications (approval / handoff /
gap) fan out through a new **`OperatorNotificationChannel` seam** (sinks: existing email+webhook, new
slack-interactive). Human replies route to the customer through a **`CustomerReplyDelivery` seam** keyed on
the conversation's channel origin. No HITL decision/ownership rule is duplicated in Slack code.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend), TypeScript/React 19/Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, Pino; existing `SlackWebApiClient`, Slack OAuth/install substrate,
approvals (`ApprovalDecisionService`), handoff/conversation-ownership service, conversation-actions outbox
(`routine_action_requests`), accounts/workspace-membership + permissions, conversation engine
**Storage**: PostgreSQL 16. New typed `channel_context` JSONB on `conversations` (only schema change). Operator
identity is resolved fresh per action (no table). Reuse `slack_installations`, `slack_channel_bindings`
(escalation_channel_id = operator channel), `slack_conversation_links`, `routine_action_requests`,
`conversation_ownership`, `pending_decisions`
**Testing**: Vitest (unit/integration/contract), Supertest, Playwright; mock Slack (signed interactivity
payloads, stubbed Slack Web API incl. `users.info`, `views.open`, `chat.update`)
**Target Platform**: Linux server (Cloud + self-host)
**Project Type**: Web (backend + frontend)
**Performance Goals**: interactivity ack < 3s (Slack limit); `views.open` for modal within the trigger window;
resolution + `chat.update` async
**Constraints**: zero user-facing credentials; multilingual (no English-keyword routing for identity/action/
origin); observability without message text/tokens/secrets; Slack app **re-consent** required (new scopes +
interactivity) — surfaced to operators; US4 needs no re-consent
**Scale/Scope**: per-workspace installs, multi-tenant by `team_id`; one operator channel per workspace binding

## Constitution Check

*GATE: passed at plan time; re-check after design.*

- ✅ Spec exists and is **Approved**; no implementation before approval.
- ✅ Backend TDD: failing tests first for signature verify (interactivity), payload parse/route, identity
  resolver (email match + authz + cache), decision-resolve adapter (incl. stale `contentHash`), ownership
  adapter (incl. stale `version`), reply persistence + customer-delivery routing, operator-notification
  fan-out, channel-context persistence + history mapping.
- ✅ Frontend: Playwright for the Activity Slack badge + detail-drawer journeys; unit tests only for the
  pure channel-context → label mapping in `frontend/lib/history-source.ts`.
- ✅ Stack unchanged (Node.js backend, React frontend). ✅ PostgreSQL.
- ✅ LLM provider default unchanged: **no new LLM path** (operator actions + replies are human-authored).
- ✅ Secrets via `.env`; `.env.example` unchanged at runtime (no new secret), but manifest scopes change →
  re-consent documented. (Identity uses the existing bot token; `users:read.email` is a scope, not a secret.)
- ✅ Customer data + auditability: identity link is least-privilege (email match within the install's
  workspace); every action emits a `hitl.*` audit event with the resolving operator (account + Slack user
  id/name provenance); no message text/tokens in logs.
- ✅ Module boundaries explicit (see Module Ownership & Seams).
- ✅ Responsibility-limited files identified: the Slack webhook/message handler stay transport-only;
  `ApprovalDecisionService` + conversation-ownership service stay Slack-unaware; `chatHistoryService` does NOT
  join Slack tables.
- ✅ **Application composition**: new app-wide wiring — interactivity router registration, `OperatorNotification`
  dispatcher + sinks, `CustomerReplyDelivery` dispatcher + provider sinks, identity resolver, interactive
  `slack.post` variant — is assembled in `backend/src/app/composition/` (mirroring 092's Slack module + the
  contact-routine module that registers approval/handoff handlers). Domain rules stay in modules.
- ⚠️ **HTTP contracts change** → `ChatConversationSummary` + conversation-detail schemas gain
  `channelContext`; update the code-first OpenAPI registry (`backend/src/app/http/openapi/...`) and regenerate
  `backend/openapi.yaml`/`.json`; sync the TS SDK (`pnpm run sync`). The interactivity endpoint is mounted on
  the connector host (`/api/connectors/slack/interactivity`), not the public OpenAPI surface (like the events
  webhook).
- ⚠️ **Cross-service contracts / message-queue review**: the `slack.post` payload gains an **interactive
  (Block Kit) variant** and a new `kind` (`operator_notification` / `human_reply`). It rides the existing
  `routine_action_requests` dispatcher (no new AMQP topic). Review: confirm idempotency-key derivation for the
  new kinds, retry semantics unchanged, update outbox/queue docs + contract tests. No document-worker payload
  change.
- ✅ **Docs**: update `docs/slack-channel.md` (interactive operator actions, re-consent, scopes), HITL/operator
  docs, Activity docs; note manifest/scope change in setup; `readme.md` if operator setup changes.

## Project Structure

### Documentation (this feature)
```text
specs/095-slack-operator-experience/
├── plan.md            # this file
├── spec.md            # approved
├── data-model.md      # operator identity + conversation channel context + outbox payload variant
├── contracts/         # interactivity payloads, block-kit action ids, history channelContext, outbox variant
├── quickstart.md      # operator walkthrough (connect → re-consent → act in Slack)
└── tasks.md           # /speckit.tasks output
```

### Source Code (repository root)
```text
backend/
├── src/
│   ├── modules/
│   │   ├── slack/                                   # shared Slack keystone (extend)
│   │   │   ├── operator/
│   │   │   │   ├── slackInteractivityRouter.ts        # NEW transport: sig+replay verify, parse `payload`, route by type
│   │   │   │   ├── slackInteractivityHandler.ts       # NEW orchestration: dispatch block_actions/view_submission
│   │   │   │   ├── slackOperatorActionResolver.ts     # NEW orchestration: identity → HITL service ports
│   │   │   │   ├── slackOperatorIdentityResolver.ts   # NEW: (team,user) → account via email match + authz, resolved fresh (no persistence)
│   │   │   │   └── slackBlockKitBuilder.ts            # NEW presentation: decision/ownership messages + reply modal + resolved update
│   │   │   ├── outbox/slackPostAction.ts              # EXTEND: interactive (blocks) variant + chat.update support
│   │   │   └── manifest/slackManifest.ts              # EXTEND: interactivity.is_enabled + request_url; +users:read,users:read.email
│   │   ├── connectors/plugins/slack/                 # inbound channel (extend)
│   │   │   ├── slackPlugin.ts                          # EXTEND: mount interactivity router; supply channel context to chat.answer
│   │   │   └── slackMessageHandler.ts                 # EXTEND: pass ConversationChannelContext via sourceContext
│   │   ├── operatorNotifications/                     # NEW seam (or under shared/domain)
│   │   │   ├── operatorNotification.ts                 # types: notification kind + action set
│   │   │   ├── operatorNotificationDispatcher.ts       # fan-out to sinks
│   │   │   ├── sinks/emailWebhookSink.ts               # wraps existing approval/handoff delivery
│   │   │   └── sinks/slackInteractiveSink.ts           # build Block Kit + enqueue interactive slack.post to operator channel
│   │   ├── handoff/                                   # conversation-ownership (extend, stay Slack-unaware)
│   │   │   └── customerReplyDelivery.ts                # NEW seam: per-provider delivery of a human_agent reply
│   │   ├── chat/services/actions/                     # existing approval.request/handoff.notify handlers → call dispatcher
│   │   └── chat/services/chatHistoryService.ts        # EXTEND: map conversations.channel_context into summary/detail
│   ├── db/migrations/
│   │   └── 110_conversation_channel_context.sql       # NEW (channel_context JSONB on conversations)
│   └── app/composition/                               # wire router, dispatchers, sinks, identity resolver
└── tests/ (contract|integration|unit)/slack + approvals + handoff + history

packages/
└── conversation-contract/                            # ConversationChannelContext discriminated union (shared port)

frontend/
├── lib/history-source.ts                             # EXTEND: slack channel-context → label/badge (pure, unit-tested)
├── components/dashboard/history/history-list.tsx     # EXTEND: render Slack badge/context
├── components/dashboard/conversation-drawer.tsx      # EXTEND: show Slack team/channel/thread/user
└── tests/e2e/                                         # Playwright: Slack activity metadata
```

**Structure Decision**: Web app. New Slack-facing transport/presentation lives under
`backend/src/modules/slack/operator/`. Cross-cutting seams (`operatorNotifications`, `customerReplyDelivery`,
`ConversationChannelContext`) are introduced as ports so the HITL/handoff/history modules stay Slack-unaware;
composition assembles the concrete sinks/resolvers. No existing god-file absorbs new concerns.

## Module Ownership & Seams

- **Transport Layer**: `slackInteractivityRouter.ts` (verify + parse + route, no business rules);
  the existing decision/ownership HTTP routes are unchanged.
- **Orchestration Layer**: `slackInteractivityHandler.ts` + `slackOperatorActionResolver.ts` (translate a Slack
  action to a HITL service call after resolving identity); `operatorNotificationDispatcher.ts` (fan-out).
- **Domain Layer**: `ApprovalDecisionService` (approvals), conversation-ownership service (handoff),
  decision/ownership invariants — **unchanged**. New domain types: `OperatorNotification`,
  `ConversationChannelContext`, customer-reply provider routing.
- **Persistence/Integration Layer**: `conversations.channel_context` read/write via the conversation
  repository (Kysely; operator identity has no persistence); interactive posting + `chat.update` via `SlackWebApiClient`;
  `users.info`/`views.open` via `SlackWebApiClient` extensions.
- **Application Composition**: registers the interactivity router on the connector host, the operator-notification
  dispatcher + email/webhook + slack sinks, the customer-reply delivery dispatcher + provider sinks, the identity
  resolver, and the interactive `slack.post` handler variant — all in `backend/src/app/composition/`.
- **Files Kept Small**: `slackWebhook.ts`/`slackMessageHandler.ts` stay transport-only; HITL domain services
  stay Slack-unaware; `chatHistoryService.ts` must NOT import Slack tables.
- **Planned Extractions**: `OperatorNotificationChannel` port + sinks; `CustomerReplyDelivery` port + provider
  sinks; `SlackOperatorIdentityResolver` port; `ConversationChannelContext` shared contract; HITL service
  **ports** consumed by the Slack resolver (avoid deep cross-module imports → keep boundary-lint green).
- **Required Refactor Stories**: refactor `ApprovalRequestActionHandler`/`HandoffNotifyActionHandler` to dispatch
  through `OperatorNotificationChannel` (behavior-preserving for email/webhook) BEFORE adding the Slack sink.

## Implementation Phases (map to spec user stories)

- **Phase A — Foundations** (serves US1/US2/US3/US4): migration (`conversations.channel_context`); manifest interactivity + scopes; interactivity router (sig+replay+parse+
  route skeleton, 401 on bad sig); `SlackOperatorIdentityResolver` (+ `users.info`); `ConversationChannelContext`
  contract + connector populates it via `sourceContext` + conversation persistence (needed by US2 reply routing);
  interactive `slack.post` payload variant + handler + `chat.update`; composition wiring. **TDD throughout.**
- **Phase B — US1 (approve/deny)**: `OperatorNotificationChannel` seam (email/webhook sink wraps existing;
  refactor approval handler to dispatch) → Slack sink builds decision Block Kit to operator channel; interactivity
  `decision_resolve` action → identity → `ApprovalDecisionService.resolve` (stale-guarded) → `chat.update`.
- **Phase C — US2 (takeover/talk/handback)**: ownership actions via interactivity → ownership service
  (version-guarded); "Talk to customer" → `views.open` modal → `view_submission` → human_agent reply;
  `CustomerReplyDelivery` seam routes the reply (slack-origin → customer DM/thread; web-origin → existing path).
  Talk is only offered after takeover (avoids orphan message on AI-owned thread).
- **Phase D — US3 (one operator channel)**: route gap + handoff notifications through the same seam interactively;
  assert no-Slack workspaces keep email/webhook unchanged with no Slack attempt.
- **Phase E — US4 (Activity metadata)**: history list+detail return `channelContext` (OpenAPI regen + SDK sync);
  frontend Slack badge + drawer; Playwright; pure mapping unit test. (Backend persistence already in Phase A.)

US4's backend persistence is in Phase A because US2's customer-reply routing depends on the conversation's
channel origin. The US4 frontend slice is otherwise independent and may land in parallel.

## Observability

New inbound path (interactivity) → signature-reject WARN logs (count, no payload), per-action audit events
extending `hitl.ownership` / decision audit with Slack provenance (account id + slack user id/name), and
outcome counters (resolved/rejected/stale/identity-miss). Customer-reply delivery failures logged + surfaced.
No raw message content, tokens, signing secrets, or cookies in logs/audit. Manifest/scope-driven re-consent
state is observable in the existing install status.

## Complexity Tracking

No constitution violations. The two new dispatch seams (`OperatorNotificationChannel`, `CustomerReplyDelivery`)
are justified: they are exactly the boundaries that keep Slack out of the HITL/handoff domains and let
no-Slack workspaces behave unchanged — the simpler "add Slack branches into each handler" alternative was
rejected because it couples three handlers to Slack and re-implements fan-out per call site.
