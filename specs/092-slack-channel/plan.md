# Implementation Plan: Slack Channel

**Branch**: `092-slack-channel` (current branch is `slack-mcp-integration`; rename pending) | **Date**: 2026-06-19 | **Spec**: `specs/092-slack-channel/spec.md`
**Input**: Feature specification from `specs/092-slack-channel/spec.md`

## Summary

Let customers talk to a Radioso agent inside Slack (DMs, then channel @mentions) and let the agent escalate to a human Slack channel when a turn produces no grounded answer — with **zero tokens entered by any user** (OAuth "Add to Slack" only) and **no Slack-as-knowledge ingestion**. Technically this is a second instance of the existing inbound conversational-channel pattern (the WhatsApp `ConnectorPlugin`) plus an OAuth install flow (reusing the `integrationOauth` substrate) and a shared Slack outbound path (one `SlackWebApiClient`, one outbox handler) fed by two distinct triggers: a typed-outcome **gap policy** and a routine-authored **`slack` skill**. A behavior-preserving precursor generalizes `customer_email_connections` into a provider-neutral `integration_connections` spine that Slack also uses.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend), TypeScript/React 19/Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, Pino, `@modelcontextprotocol` (unused here), Slack Web API (via direct HTTPS calls through the existing SSRF-guarded fetch client — no heavy SDK required), existing `integrationOauth`, `fieldEncryption`, conversation engine, connectors substrate, conversation-actions outbox
**Storage**: PostgreSQL 16 (+pgvector unused here). New tables: `integration_connections`, `slack_installations`, `slack_channel_bindings`, `slack_conversation_links`, `slack_inbound_events`; extend `agent_skills` kind check with `slack`; reuse `integration_oauth_connections`, `conversations.source_channel`, `routine_action_requests`
**Testing**: Vitest (unit/integration/contract), Supertest, Playwright (admin settings + install UX); mock Slack (OAuth, Events API signature, Web API) fixtures
**Target Platform**: Linux server (Cloud + self-host)
**Project Type**: Web (backend + frontend)
**Performance Goals**: inbound event ack < 3s (Slack hard limit, FR-008); turn + reply async
**Constraints**: zero user-facing credentials; multilingual (no English-keyword routing); observability without message text/secrets; public HTTPS reachability required for OAuth callback + events
**Scale/Scope**: per-workspace installs; one shared event URL multi-tenant by `team_id`

## Constitution Check

*GATE: passed at plan time; re-check after Phase 1 design.*

- ✅ Spec exists and is **Approved**; no implementation before approval.
- ✅ Backend TDD: failing tests first for signature verification, dedupe/loop-guard, identity→conversation mapping, gap-trigger typed-outcome, outbox handler, OAuth token-normalizer.
- ✅ Frontend: Playwright for the "Add to Slack" + agent/escalation-channel + self-host manifest journeys; unit tests only for non-visual form/state logic.
- ✅ Stack unchanged (Node.js backend, React frontend).
- ✅ PostgreSQL.
- ✅ LLM provider default unchanged (no new LLM path; answers reuse the existing turn — assistant copy stays LLM-generated, FR-014).
- ✅ Secrets via `.env`; `.env.example` adds `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` (FR-004).
- ✅ Customer data + auditability: identity/count-only observability (FR-021); dedupe + idempotency tables; no message text/secrets in logs.
- ✅ Module boundaries explicit (see Module Ownership & Seams).
- ✅ Responsibility-limited files identified; no god-object growth (conversation engine/`ChatService`/generic OAuth service stay Slack-unaware).
- ✅ **Application composition**: new app-wide wiring (Slack OAuth provider registration, Slack connector plugin registration, `slack.post` action handler registration, `slack` skill executor registration) is evaluated against `backend/src/app/composition/` and registered there / in `dependencyBuilders.ts`, mirroring customer-email and webhook precedents. Domain rules stay in the new `slack` module.
- ⚠️ **HTTP contracts change** → OpenAPI registry `backend/src/app/http/openapi/document.ts` must add the Slack settings/admin endpoints (install start/status, binding config, manifest); `backend/openapi.yaml`/`.json` are regenerated, never hand-edited. The inbound Slack webhook is mounted via the connector host (`/api/connectors/slack/...`), not the public OpenAPI surface.
- ⚠️ **Cross-service contracts**: a new outbox action type (`slack.post`) and a new typed turn-outcome field on `ConnectorChatPort` results. Message-queue impact review required: the action rides the existing `routine_action_requests` dispatcher (no new AMQP topic); confirm retry/idempotency semantics and update outbox docs/tests. No document-worker payload change.
- ✅ **Docs** (FR-024): Cloud + self-host setup, data-flow, curated-only stance; connector docs; outbox action docs; `.env.example`.

## Project Structure

### Documentation (this feature)
```text
specs/092-slack-channel/
├── plan.md            # this file
├── spec.md            # approved
├── research.md        # decisions + reuse map (path:line evidence)
├── data-model.md      # generic integration_connections spine + Slack tables
├── contracts/         # endpoint + outbox-action + manifest contracts
├── quickstart.md      # to add: Cloud + self-host walkthrough
└── tasks.md           # /speckit.tasks output (next step)
```

### Source Code (repository root)
```text
backend/
├── src/
│   ├── modules/
│   │   ├── integrationConnections/        # NEW generic spine: repo + service + lifecycle
│   │   │   └── (subsumes customer_email connection lifecycle)
│   │   ├── slack/                          # NEW shared keystone
│   │   │   ├── client/slackWebApiClient.ts        # postMessage/conversations/users via SSRF-guarded fetch
│   │   │   ├── oauth/slackProvider.ts             # provider def + token-response normalizer
│   │   │   ├── manifest/slackManifest.ts          # APP_BASE_URL-filled app manifest generator
│   │   │   ├── install/slackInstallationService.ts
│   │   │   └── outbox/slackPostActionHandler.ts   # one handler; gap + routine + reply
│   │   ├── connectors/plugins/slack/        # NEW inbound channel (mirrors plugins/whatsapp/)
│   │   │   ├── slackPlugin.ts
│   │   │   ├── slackWebhook.ts                     # url_verification, signature+replay, dedupe, loop-guard, fast-ack
│   │   │   └── slackMessageHandler.ts              # identity→conversation, run turn, reply, gap-policy enqueue
│   │   ├── slackSkills/                      # NEW routine-authored path
│   │   │   ├── domain.ts · routineSkillResolver.ts · executor/slackEscalationExecutor.ts
│   │   └── customerEmail/                    # MODIFIED: connectionId now → integration_connections
│   ├── modules/integrationOauth/            # MODIFIED: per-provider token-response normalizer seam
│   ├── modules/chat/ (ConnectorChatPort)    # MODIFIED: surface typed grounded-answer outcome
│   ├── db/migrations/                        # NEW migrations (see data-model)
│   └── app/composition + app/server/dependencyBuilders.ts  # MODIFIED: register provider/plugin/handler/executor
├── openapi.yaml / openapi.json              # regenerated
└── tests/ (unit · integration · contract)

frontend/
├── components/dashboard/settings/           # NEW Slack settings: Add-to-Slack, agent + escalation-channel pickers, self-host manifest panel
├── app/oauth/connections/callback/          # REUSED generic OAuth callback
└── tests/ (Playwright journeys + non-visual unit)
```

**Structure Decision**: Web app. The `slack` module owns the keystone (client + install + manifest + oauth provider + outbox handler). The inbound channel is a `ConnectorPlugin` under `connectors/plugins/slack/`. The routine path is `slackSkills/`. The generic connection lifecycle is `integrationConnections/`. The conversation engine, `ChatService`, generic OAuth service, connector host, and outbox dispatcher remain unmodified except for the one typed-outcome field and standard registrations.

## Module Ownership & Seams

- **Transport Layer**: `connectors/plugins/slack/slackWebhook.ts` (Slack wire: challenge, signature/replay, dedupe, fast-ack) mounted via the connector host at `/api/connectors/slack/...`; admin REST routes for install/binding/manifest under the OpenAPI surface; reused `/oauth/callback/:provider`.
- **Orchestration Layer**: `slackMessageHandler.ts` coordinates identity→conversation, calls `ConnectorChatPort.answer(... sourceChannel:"slack")`, posts reply, and (on typed no-context outcome) enqueues the gap-escalation `slack.post`. Adds no turn logic.
- **Domain Layer**: `slack/` (client, install, manifest, oauth normalizer, outbox handler), `slackSkills/` (executor + resolver), `integrationConnections/` (lifecycle/state machine).
- **Persistence/Integration Layer**: new repositories for the spine + Slack tables; `SlackWebApiClient` (HTTP to Slack); reuse `integration_oauth_connections`, `routine_action_requests`, `conversations`.
- **Application Composition**: register the Slack OAuth provider (env-gated, like Gmail/Outlook), the Slack connector plugin, the `slack.post` action handler, and the `slack` skill executor — in composition/`dependencyBuilders.ts`. Feature is cleanly disabled when env secrets are absent (FR-005).
- **Files Kept Small**: conversation engine, `ChatService`, `integrationOauth` generic service, connector registry/host, outbox dispatcher — MUST NOT gain Slack branches; Slack enters only as registered provider/plugin/handler/executor + one typed field.
- **Planned Extractions**: `integration_connections` spine (generalizing email); per-provider OAuth token-response normalizer; typed grounded-answer outcome on `ConnectorChatPort`.
- **Required Refactor Stories**: **Phase R (precursor)** — generalize the connection layer + migrate customer email, behavior-preserving, landed before Slack tables consume the spine.

## Phasing (maps to spec user stories)

- **Phase R — connection-layer generalization (precursor, behavior-preserving).** Introduce `integration_connections`; migrate `customer_email_connections` into it; repoint email repos/services; prove email unchanged (existing email tests green, no behavior diff). No Slack code. *Own PR.*
- **Phase 0 — Slack keystone.** `slack` module: install store (`slack_installations`), `SlackWebApiClient`, Slack OAuth provider + token-response normalizer, manifest generator, env wiring, feature-flag/disabled-when-unconfigured. (Enables US1/US3 substrate; FR-001..005, FR-020/021.)
- **Phase 1 — talk through Slack (DM) [US1, P1].** Slack `ConnectorPlugin` (webhook: challenge, signature+replay, dedupe, loop-guard, fast-ack), identity→conversation mapping, run turn, reply via client; OAuth install UI + agent picker. (FR-006..011, 013..015.)
- **Phase 2 — escalate on gaps [US2, P2].** Surface typed grounded-answer outcome on `ConnectorChatPort`; gap policy enqueues `slack.post`; one outbox handler; escalation-channel config UI; routine `slack` skill (routine path). (FR-016..020.)
- **Phase 3 — self-host manifest first-class [US3, P3].** Manifest panel rendered with `APP_BASE_URL`; disabled-state guidance; `.env.example` + docs. (FR-021, 024.) *(Most of the mechanism lands in Phase 0; this is UX + docs + verification.)*
- **Phase 4 — @mention in channels [US4, P4].** `app_mention` event, thread-scoped conversations, in-thread reply. (FR-012.)

Each phase is independently shippable behind the feature flag; observability (FR-022) and docs (FR-024) land within the phase that introduces the path.

## Complexity Tracking

| Decision | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| New `integration_connections` spine (Phase R refactor of shipped email) | Slack's inbound `team_id` routing + shared connection lifecycle would otherwise duplicate the 089 lifecycle per provider; generalizing now avoids a third copy and gives a uniform connect/disable/reauth surface | Reusing `integration_oauth_connections` directly rejected: it's keyed workspace-first and is the *credential* table; overloading it with channel routing/config re-introduces the boundary smell. A bespoke `slack_*` table with no generalization rejected per user direction (avoid per-provider connection tables). |
| Slack detail table (`slack_installations`) despite the generic spine | `team_id` must be a UNIQUE indexed inbound key and bindings are FKs — cannot live in `config` JSONB | Storing `team_id` in JSONB rejected: no unique constraint / poor inbound lookup. |
| New typed turn-outcome field on `ConnectorChatPort` | Gap escalation must trigger on structure, not reply text (multilingual + robustness) | Parsing assistant text rejected (fragile, English-keyword violation). |

## Risks / Dependencies (carried from research.md)

- **Cloud:** public Slack App Directory review (Radioso-side, lead time). Does not block self-host or dev (dev app). 
- **Public HTTPS reachability** required for OAuth callback + events.
- **Slack non-standard OAuth token envelope** → per-provider normalizer (Phase 0).
- **Phase R touches a shipped feature** → behavior-preserving, own PR, email regression suite must stay green before Slack consumes the spine.
