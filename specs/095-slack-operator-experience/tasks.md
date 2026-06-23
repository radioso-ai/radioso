# Tasks: Slack operator experience (095)

**Input**: `specs/095-slack-operator-experience/{spec,plan,data-model}.md`
**Prerequisites**: plan.md ✅, spec.md ✅ (Approved), data-model.md ✅
**TDD**: backend tests written and failing before implementation. Frontend visible behavior → Playwright.
**Conventions**: `[P]` = parallelizable (different files, no dep). `[US#]` = owning user story.

---

## Phase A — Foundations (blocking; serves US1–US4)

- [ ] A01 [P] (revised) Operator identity is resolved **fresh per action** (no table/repository) — `SlackOperatorIdentityResolver` only (see A04/A05). Owner decision: avoid a Slack-specific table.
- [ ] A02 [P] Migration `conversations.channel_context JSONB` (`1xx_conversation_channel_context.sql`); extend conversation repository read/write + unit test (round-trip + null back-compat).
- [ ] A03 [P] `ConversationChannelContext` discriminated union in `packages/conversation-contract` (+ export); type-only.
- [ ] A04 TEST: `slackOperatorIdentityResolver` — cache hit, email-match upsert, member-removed re-check, unauthorized → rejected, no-email → rejected (`backend/tests/unit/slack/operator-identity-resolver.test.ts`).
- [ ] A05 Implement `SlackOperatorIdentityResolver` + `WorkspaceMemberLookupPort` (findByEmail) + `SlackWebApiClient.usersInfo` extension.
- [ ] A06 TEST: interactivity router — valid sig routes by type, forged/stale sig → 401, malformed payload → 400, ack < timing budget (`backend/tests/contract/slack-interactivity.contract.test.ts`).
- [ ] A07 Implement `slackInteractivityRouter.ts` (raw-body sig+replay verify — share with events; parse urlencoded `payload`; route `block_actions`/`view_submission`/`view_closed`) + mount in `slackPlugin.ts`; manifest `interactivity.is_enabled=true` + request_url.
- [ ] A08 Manifest scopes += `users:read`, `users:read.email` (`slackManifest.ts`); update self-host manifest doc + re-consent note; `.env.example` if needed.
- [ ] A09 TEST: interactive `slack.post` variant — blocks postMessage, `updateTs` → chat.update, idempotency per new kind, fallback text required (`backend/tests/unit/slack/slack-post-action.test.ts` extend).
- [ ] A10 Extend `slackPostPayloadSchema` + `SlackPostActionHandler` for blocks + `chat.update` (`slack/outbox/slackPostAction.ts`); `SlackWebApiClient.updateMessage`.
- [ ] A11 Compose: register interactivity router, identity resolver, interactive post handler in `backend/src/app/composition/`.

## Phase B — US1: approve/deny a decision from Slack

- [ ] B01 [US1] TEST: `OperatorNotificationDispatcher` fan-out — email/webhook sink preserves existing approval delivery, slack sink only when operator channel configured (`backend/tests/unit/operator-notifications/dispatcher.test.ts`).
- [ ] B02 [US1] Introduce `OperatorNotification` type + `OperatorNotificationDispatcher` + `emailWebhookSink` (wrap existing approval/handoff delivery); refactor `ApprovalRequestActionHandler` to dispatch (behavior-preserving) — TDD, existing approval tests still green.
- [ ] B03 [US1] TEST: `slackInteractiveSink` builds decision Block Kit (option buttons, action_id/value per data-model) to operator channel; no channel → skip (`.../slack-interactive-sink.test.ts`).
- [ ] B04 [US1] Implement `slackBlockKitBuilder.buildDecisionMessage` + `slackInteractiveSink` (enqueue interactive slack.post to binding's operator channel).
- [ ] B05 [US1] TEST: `slackOperatorActionResolver.resolveDecision` — identity→`ApprovalDecisionService.resolve`, stale `contentHash` rejected, non-member ephemeral, success returns outcome for update (`.../slack-operator-action-resolver.test.ts`).
- [ ] B06 [US1] Implement decision branch in `slackInteractivityHandler` + `slackOperatorActionResolver.resolveDecision`; on success enqueue `chat.update` (resolved message); ephemeral reject via `response_url`.
- [ ] B07 [US1] Audit: decision-resolved-from-slack event carries `slackOperator` provenance; counters for resolved/stale/identity-miss.
- [ ] B08 [US1] INTEGRATION: routine→approval gate (Slack workspace) → interactive message enqueued → signed Approve payload → decision approved + routine resumed + chat.update; stale + non-member + forged variants (`backend/tests/integration/slack/slack-decision.integration.test.ts`).

## Phase C — US2: take over / talk to customer / hand back

- [ ] C01 [US2] TEST: ownership adapter — takeover→human_owned(version++), handback→ai_owned, stale version rejected (`.../slack-ownership-adapter.test.ts`).
- [ ] C02 [US2] Implement ownership branches in resolver/handler via conversation-ownership service ports; build ownership Block Kit (`buildOwnershipMessage`); talk offered only after takeover.
- [ ] C03 [US2] TEST: `CustomerReplyDelivery` — slack-origin reply enqueues `human_reply` slack.post to customer DM/thread; web-origin → no slack post; provider switch on `channel_context` (`.../customer-reply-delivery.test.ts`).
- [ ] C04 [US2] Implement `CustomerReplyDelivery` port + provider sinks (slack, web no-op); invoke whenever a human_agent reply is persisted (from Slack AND dashboard reply path).
- [ ] C05 [US2] TEST: reply modal flow — `ownership_talk` → views.open; `view_submission` → ownership `reply` (source=human_agent, metadata.humanAgent) → delivery (`.../slack-reply-modal.test.ts`); SlackWebApiClient.viewsOpen extension.
- [ ] C06 [US2] Implement modal open + `view_submission` handling + reply persistence + delivery + chat.update of the operator message to current owner/state.
- [ ] C07 [US2] INTEGRATION: slack-origin takeover→talk→customer DM delivered→handback; web-origin reply surfaces in web path, no customer slack post; stale-version refresh (`backend/tests/integration/slack/slack-takeover.integration.test.ts`).

## Phase D — US3: one interactive operator channel (gap + approval + handoff)

- [ ] D01 [US3] Refactor `HandoffNotifyActionHandler` to dispatch through `OperatorNotificationDispatcher` (email/webhook preserved) + add ownership-action Block Kit via slack sink — TDD, existing handoff tests green.
- [ ] D02 [US3] Route gap escalation through the operator-notification seam as an interactive message (upgrade `slackMessageHandler` gap path from plain text); keep same operator channel (`escalation_channel_id`).
- [ ] D03 [US3] TEST: each event type (gap/approval/handoff) → interactive message to the one operator channel with correct action set; no-Slack workspace → email/webhook unchanged + no Slack attempt (`backend/tests/integration/slack/operator-channel.integration.test.ts`).

## Phase E — US4: Slack metadata in Activity

- [ ] E01 [US4] Slack connector supplies `ConversationChannelContext` via `sourceContext.channelContext` (DM=im, mention=channel + threadTs + user; resolve `users.info` display name) — `slackMessageHandler.ts`; persistence covered by A02.
- [ ] E02 [US4] TEST: history presenter maps `channel_context` into list+detail DTOs; no Slack-table import (`backend/tests/unit/...history-channel-context.test.ts`).
- [ ] E03 [US4] Add `channelContext` to history list+detail response schemas (code-first OpenAPI registry) + `chatHistoryService`/presenter mapping; regenerate `backend/openapi.{yaml,json}`; `pnpm run sync` SDK.
- [ ] E04 [US4] CONTRACT TEST: history endpoints return `channelContext` for slack vs web conversations (`backend/tests/contract/history-channel-context.contract.test.ts`).
- [ ] E05 [US4] Frontend pure mapping: `frontend/lib/history-source.ts` slack channel-context → badge+label ("Slack — #channel / DM", thread, user) + unit test (logic only).
- [ ] E06 [US4] Render Slack badge/context in `history-list.tsx` + detail in `conversation-drawer.tsx`.
- [ ] E07 [US4] Playwright: Activity shows Slack badge + drawer context for DM + channel conversations; web conversation unaffected (`frontend/tests/e2e/slack-activity-metadata.spec.ts`).

## Cross-cutting (close-out)

- [ ] X01 Message-queue impact review write-up (outbox `slack.post` variant + new kinds): idempotency, retry, queue docs/tests — append to plan/contracts.
- [ ] X02 Docs: `docs/slack-channel.md` (interactive operator actions, scopes, re-consent), HITL/operator docs, Activity docs; `.env.example`/manifest; `readme.md` if operator setup changes.
- [ ] X03 Verify: `pnpm run ci:local -- origin/main` (clean integration DB w/ vector ext); backend unit + targeted integration; frontend build+lint+unit+e2e; boundary-lint; OpenAPI/SDK current.

## Dependencies / parallelism

- A01–A03 parallel; A04→A05; A06→A07→A08; A09→A10→A11. Phase A blocks B/C/D.
- B before D (D reuses the dispatcher + sinks). C depends on A (channel_context) + B (sink/handler scaffolding).
- E05–E07 (frontend) parallel to B/C/D once E03 contract lands; E01 depends on A02/A03.
