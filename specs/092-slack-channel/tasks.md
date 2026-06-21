# Tasks: Slack Channel

**Input**: Design documents from `/specs/092-slack-channel/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/README.md

**Tests**: Backend is TDD — tests written and FAILING before implementation. Frontend user-visible journeys use Playwright; frontend unit tests cover only non-visual logic.

**Conventions**: run one backend test file with `pnpm exec vitest run <path>` (the `pnpm test -- <path>` filter runs the whole suite). Regenerate OpenAPI via the code-first registry; never hand-edit `backend/openapi.yaml`/`.json`. Run `pnpm run ci:local -- origin/main` before each PR. Each phase is an independently shippable increment behind a feature flag; ship Phase R as its own PR.

**Labels**: `[P]` parallelizable (different files, no dep) · `[R]` precursor refactor · `[F0]` foundational keystone · `[US1..US4]` user stories.

---

## Phase R: Connection-layer generalization (precursor — own PR, behavior-preserving) 🚧 BLOCKS Slack persistence

**Goal**: Introduce a provider-neutral `integration_connections` spine and migrate customer email onto it with **zero behavior change**, so Slack can reuse the spine. No Slack code in this PR.

**Independent Test**: Full existing customer-email suite green; email connect/disable/reauth/health and email-skill runs behave identically; data migration round-trips.

- [ ] T001 [R] Blast-radius scan: list every reference to `customer_email_connections` / `CustomerEmailConnection` repo+service+routes+tests; record in this file before edits.
- [ ] T002 [R] Migration: create `integration_connections` (spine per data-model.md) + indexes `(workspaceId)`,`(workspaceId,provider)`,`(oauthConnectionId)`.
- [ ] T003 [R] Migration: backfill rows from `customer_email_connections` (lifecycle → columns; sender fields → `config` JSONB; map provider naming), then drop `customer_email_connections`. Reversible/tested.
- [ ] T004 [R] Tests FIRST: `integrationConnections` repository + lifecycle state-machine unit tests (`backend/tests/.../integrationConnections.*`).
- [ ] T005 [R] Implement `backend/src/modules/integrationConnections/` (repository, service, status state machine) per data-model state transitions.
- [ ] T006 [R] Repoint `backend/src/modules/customerEmail/` (connection repo/service + skill executor `connectionId`) to `integration_connections`; keep email domain (sender fields) reading from `config`.
- [ ] T007 [R] Update customer-email tests for the new connection source; confirm the **email behavior suite is unchanged** (no assertion changes beyond table/source).
- [ ] T008 [R] Update affected docs/specs references (089 data-model note) + run `pnpm run ci:local -- origin/main`.

**Checkpoint**: Email runs on the generic spine, byte-for-byte behavior. Merge before Phase 0.

---

## Phase 0: Slack keystone (Foundational) ⚠️ BLOCKS all Slack user stories

**Purpose**: One Slack module: credentials/install, Web API client, OAuth provider + token normalizer, manifest, env wiring, disabled-when-unconfigured. Feature flag added.

- [ ] T009 [F0] Env: add `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` to `backend/src/app/config/env.ts` (optional, empty→undefined) + `.env.example`. Feature unavailable when absent (FR-005).
- [ ] T010 [F0] Migrations: `slack_installations` (teamId UNIQUE, botUserId, FK→integration_connections), `slack_channel_bindings`, `slack_conversation_links` (slackKey UNIQUE), `slack_inbound_events` (eventId PK); extend `agent_skills` kind check with `slack`.
- [ ] T011 [P][F0] Tests FIRST: OAuth **token-response normalizer** for Slack's `oauth.v2.access` envelope (`{ok, access_token, team, authed_user, bot_user_id}`) incl. `ok:false` error path.
- [ ] T012 [F0] Add per-provider token-response normalizer seam to `backend/src/modules/integrationOauth/` (general hook, no Slack branch in generic code) + Slack provider definition (`slack/oauth/slackProvider.ts`): endpoints `oauth/v2/authorize` + `api/oauth.v2.access`, scopes from manifest.
- [ ] T013 [P][F0] Tests FIRST: `SlackWebApiClient` (postMessage, conversations.list, users.info) over the SSRF-guarded fetch client — success, Slack `ok:false`, transient failure.
- [ ] T014 [F0] Implement `slack/client/slackWebApiClient.ts` (HTTP only; knows nothing of conversations/routines).
- [ ] T015 [P][F0] Tests FIRST: `slackInstallationService` — store/refresh installation keyed by teamId, credential via integration_connections→integration_oauth_connections, status transitions.
- [ ] T016 [F0] Implement `slack/install/slackInstallationService.ts` + `slack_installations`/binding repositories.
- [ ] T017 [P][F0] Tests FIRST: manifest generator renders redirect + event URLs from `APP_BASE_URL` and excludes search scopes.
- [ ] T018 [F0] Implement `slack/manifest/slackManifest.ts` (FR-021 contract in contracts/README §5).
- [ ] T019 [F0] Composition: register the Slack OAuth provider (env-gated, mirroring `customerEmail` composition) in `backend/src/app/composition/` / `dependencyBuilders.ts`; cleanly disabled when env absent.

**Checkpoint**: Install plumbing + client exist and are unit-green; no inbound/outbound user path yet.

---

## Phase 1: Talk through Slack (DM) [US1, P1] 🎯 MVP

**Goal**: One-click install, then a customer DMs the bot and gets a curated answer; gaps decline safely.

**Independent Test**: contracts/README §2 (DM) end-to-end against mock Slack — install→bind agent→`message.im`→signed/deduped/loop-safe ack<3s→conversation `source_channel=slack`→grounded reply; no UI token entry.

### Tests (write first, must fail)
- [ ] T020 [P][US1] Contract test: admin REST install start/status + binding (contracts/README §1) — no secret ever in request/response.
- [ ] T021 [P][US1] Contract test: inbound webhook — `url_verification` challenge; signature + replay-window reject; `event_id` dedupe; bot-loop suppression; 3s ack.
- [ ] T022 [P][US1] Integration test: full DM journey (install→`message.im`→reply) + multi-turn resume (same `(team_id,user)`), via mock Slack fixtures.
- [ ] T023 [P][US1] Integration test: no-grounded-knowledge question → safe LLM-generated decline (no fabricated answer), no hard-coded string.
- [ ] T024 [P][US1] Playwright: "Add to Slack" → consent (mocked) → choose answering agent → connected; zero token fields present.

### Implementation
- [ ] T025 [US1] Admin REST routes (install start/status, binding GET/PUT, disconnect) + add to OpenAPI registry `backend/src/app/http/openapi/document.ts`; regenerate `openapi.yaml`/`.json`.
- [ ] T026 [US1] Slack `ConnectorPlugin` scaffold `backend/src/modules/connectors/plugins/slack/slackPlugin.ts` (mirror `plugins/whatsapp/`); mount `slackWebhook` at `/api/connectors/slack/events`.
- [ ] T027 [US1] `slackWebhook.ts`: `url_verification`, `v0=` HMAC over `v0:{ts}:{rawBody}` + replay window, `event_id` dedupe insert (`slack_inbound_events`), bot-loop guard via `botUserId`, fast-ack, async dispatch.
- [ ] T028 [US1] `slackMessageHandler.ts`: route by `team_id`→installation→binding; identity→conversation mapping (`slack_conversation_links`, DM user-scoped); call `ConnectorChatPort.answer({sourceChannel:"slack"})`; post reply via `SlackWebApiClient` (in-thread).
- [ ] T029 [US1] Composition: register the Slack connector plugin (env/flag-gated).
- [ ] T030 [P][US1] Frontend: Slack settings section (`frontend/components/dashboard/settings/`) — Add-to-Slack button, agent picker, connected/needs-reauth state; reuse generic `app/oauth/connections/callback`.
- [ ] T031 [US1] Observability (FR-021): identity/count-only logs+spans for install, inbound receipt, turn dispatch, reply — no text/secrets.

**Checkpoint**: Customers can DM the agent end-to-end, zero-token install. Demoable MVP.

---

## Phase 2: Escalate on gaps [US2, P2]

**Goal**: No-grounded-answer turns auto-post to a human channel (channel policy, typed outcome); routines can also post via a `slack` skill; both share one outbox handler/client.

**Independent Test**: typed `no_context` outcome → `slack.post` enqueued from the typed field (not text) → delivered with retry/idempotency; separately a routine `slack` skill reaches the same handler without triggering the gap path.

### Tests (write first, must fail)
- [ ] T032 [P][US2] Unit: gap policy enqueues `slack.post` **iff** the turn's typed outcome is `no_context`; asserts trigger reads the typed field, never `answer` text (SC-009).
- [ ] T033 [P][US2] Unit: `slack.post` action handler — credential resolve (installation→integration_connections→oauth), post via client, retry/backoff, idempotency-key dedupe (FR-018).
- [ ] T034 [P][US2] Integration: gap turn → escalation lands in configured channel; unconfigured channel → safe no-op (FR-017).
- [ ] T035 [P][US2] Integration: routine `slack` skill → same handler/client as gap path; gap path not triggered for that turn (FR-019).
- [ ] T036 [P][US2] Playwright: configure escalation channel in Slack settings.

### Implementation
- [ ] T037 [US2] Add typed grounded-answer outcome to `ConnectorChatPort` result (contracts/README §3) sourced from the existing grounded-answer flag — narrow field, no engine Slack-awareness.
- [ ] T038 [US2] Gap-escalation policy in `slackMessageHandler` (post-turn): on `no_context`, enqueue `slack.post {kind:"gap_escalation"}` with per-turn idempotency key.
- [ ] T039 [US2] `slack/outbox/slackPostActionHandler.ts` + register `slack.post` on the conversation-actions outbox dispatcher; message-queue impact note (rides `routine_action_requests`, no new topic).
- [ ] T040 [US2] `slack` skill kind: `slackSkills/domain.ts`, `routineSkillResolver.ts`, `executor/slackEscalationExecutor.ts` (enqueues same `slack.post {kind:"routine_post"}`); register executor in composition.
- [ ] T041 [P][US2] Frontend: escalation-channel picker in Slack settings + routine `slack` skill authoring (clone email/MCP skill section).
- [ ] T042 [US2] Observability for outbound delivery (count/outcome only).

**Checkpoint**: Answer-or-handoff works; "both" directions complete.

---

## Phase 3: Self-host manifest first-class [US3, P3]

**Goal**: Self-host operator enables Slack via a generated manifest + env; same zero-token user flow.

**Independent Test**: manifest renders with `APP_BASE_URL`; env present → provider registers + Add-to-Slack enabled; env absent → clean unavailable state; secrets never logged.

- [ ] T043 [P][US3] Test: `GET …/slack/manifest` returns base-URL-filled manifest + env var checklist; disabled-state contract when env missing.
- [ ] T044 [US3] Manifest admin endpoint + OpenAPI entry; wire to `slackManifest` (T018).
- [ ] T045 [P][US3] Frontend: self-host manifest panel (copy-ready manifest + env checklist + reachability note).
- [ ] T046 [P][US3] Playwright: self-host setup walkthrough (manifest shown, disabled-without-env guidance).
- [ ] T047 [US3] Docs: self-host + Cloud setup, data-flow, curated-only/no-history stance in `docs/` (FR-024).

**Checkpoint**: Self-host and Cloud share one OAuth path.

---

## Phase 4: @mention in channels [US4, P4]

**Goal**: @mention the bot in a shared channel; reply in-thread; thread = conversation.

**Independent Test**: `app_mention` → in-thread reply; repeated mention in thread continues one conversation; non-mention chatter ignored.

- [ ] T048 [P][US4] Tests first: `app_mention` handling, thread-scoped mapping `(team,channel,thread_ts)`, ignore non-mention messages.
- [ ] T049 [US4] Extend `slackWebhook`/`slackMessageHandler` for `app_mention` + thread-scoped `slack_conversation_links`; in-thread reply (`thread_ts`).
- [ ] T050 [P][US4] Integration + Playwright (if applicable) coverage for channel mention journey.

**Checkpoint**: DM + channel mention both work.

---

## Final: Polish & cross-cutting

- [ ] T051 [P] Quickstart: write `specs/092-slack-channel/quickstart.md` (Cloud + self-host) and validate steps.
- [ ] T052 [P] Outbox/queue docs + tests updated for `slack.post` (retry/idempotency).
- [ ] T053 Long-message chunking/truncation + link-only citations (drop doc/chunk IDs) in Slack reply formatting (FR-015, edge cases).
- [ ] T054 Token-revoked/uninstalled → `needs_reauth` + safe degrade + re-install path (FR-022) test + impl.
- [ ] T055 Final `pnpm run ci:local -- --all`; record result in PR body.

---

## Dependencies & Execution Order

- **Phase R** (precursor) → merge before Phase 0 (Slack persistence depends on the spine).
- **Phase 0** (foundational) BLOCKS US1–US4.
- **US1 (P1)** → MVP; **US2 (P2)** depends on F0 + the typed-outcome field (T037); **US3 (P3)** depends on F0 manifest (T018); **US4 (P4)** extends US1 handlers.
- Within a story: backend tests fail first → focused modules → orchestration → composition wiring; OpenAPI regenerated whenever HTTP contracts change; Playwright for visible journeys.

## Parallel opportunities

- Phase 0: T011/T013/T015/T017 (normalizer, client, install service, manifest) are independent test-first tracks.
- Each story's `[P]` tests run together; frontend `[P]` tasks parallel backend.
- Delegation: Phase R, Phase 0, and each user story are clean units for separate Codex agents in worktrees (orchestrate + independently verify; sequence R first).

## Notes
- Keep conversation engine, `ChatService`, generic OAuth service, connector host, and outbox dispatcher Slack-unaware — Slack enters only as registered provider/plugin/handler/executor + one typed field.
- No manual-token code path anywhere. No `search.messages`/history ingestion. No English-keyword routing.
- Commit per task/logical group; stop at each checkpoint to validate the story independently.
