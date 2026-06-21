# Research & Design Decisions: Slack Channel

This captures the decisions behind `spec.md`, the rejected alternatives, and the concrete reuse points (with file paths) discovered while scoping. Implementers should not re-derive these.

## Canonical goal

Let a customer **talk to a Radioso agent inside Slack** and let the agent **escalate to a human Slack channel** when curated knowledge does not cover the question — with **zero tokens entered by any Radioso user** (OAuth "Add to Slack" only) and **without ingesting Slack as a knowledge source**.

## The three Slack integrations, and why this is the right one

During scoping we distinguished three distinct features that all involve "Slack":

1. **Use a third-party Slack MCP server** (e.g. `korotovsky/slack-mcp-server`) as an external skill. Rejected as the product answer: requires the operator to self-host and publicly expose an HTTP MCP server (Radioso is a remote-HTTP MCP client only; it cannot spawn stdio), and Radioso's SSRF guard requires a public `https://` endpoint. High setup burden, not "convenient".
2. **A first-party outbound Slack connector** ("Radioso acts on Slack" — post/notify). Kept, but narrowed to **escalation only** (US2). The general "search Slack to ground answers" sub-capability is cut (see Non-Goals rationale).
3. **A first-party inbound Slack channel** ("talk to Radioso through Slack"). This is the core (US1) — it matches the user's actual goal.

The MCP server (option 1) is irrelevant to the chosen design.

## Key decisions

### D1 — Zero user-facing tokens; OAuth "Add to Slack" is the only path
Manual bot-token / signing-secret entry is removed from the product UI entirely. OAuth centralizes **all** secrets (client secret *and* signing secret are app-level), so the install becomes one click for admins and nothing for customers.

- **Cloud:** Radioso owns one distributed Slack app; its secrets live in Radioso env. Customers/admins enter nothing.
- **Self-host:** the *operator* registers their own app once (via a generated manifest) and sets three app secrets in env — the same category as `DATABASE_URL`, not a per-user UI step. This is aligned with self-host data sovereignty (their app, their data path), not a tax.
- Irreducible floor: a Slack app must exist; that is Slack's requirement, not Radioso's. The bar we hold is "no Radioso *user* pastes a token into the product."

### D2 — Curated knowledge only; Slack is a front door + escalation surface, not a source
Answers come solely from curated knowledge with normal grounding discipline. Slack history is **not** ingested and `search.messages` is **not** used. Rationale converges on two axes:
- **Convenience:** `search.messages` is the *only* capability needing a Slack **user** token (`xoxp`) — the painful auth path. Cutting it means we only ever need a **bot** token, which is what makes one-click install viable.
- **Philosophy:** Slack history is an un-curated dump; grounding on it contradicts Radioso's reason for being. The on-philosophy way to feed knowledge from Slack would be human-gated promotion (react-to-save into a reviewed draft) — noted as future, not built here.

### D3 — One Slack app, one credential, one client; two consumers
The genuinely shared piece is small: a `slack` module owning the **connection/credentials** and a **`SlackWebApiClient`**. The inbound channel's reply-into-thread and the escalation post are the *same* `chat.postMessage`. The channel (a `ConnectorPlugin`) and the escalation (a skill-kind executor) both depend down on the `slack` module; neither depends on the other. This avoids building two disconnected Slack integrations.

### D4 — Multi-tenant by `team_id`, single event URL
One Slack app ⇒ one Event Subscription URL configured once (never by a user). Installs are keyed by `team_id`; inbound events route by `team_id` → workspace+agent. Even the webhook URL is invisible to users.

### D5 — Threading model: thread = conversation (default)
DMs map per-user; `app_mention` threads map per-thread. Each Slack thread is its own conversation. (User-scoped rolling DM is the natural DM behavior; channel threads are thread-scoped.)

### D6 — Replies are completed messages, not streamed
Slack is not an SSE consumer. Use the non-streaming turn path and post the final answer. A "thinking…" placeholder + `chat.update` is an optional later refinement.

### D7 — Two escalation triggers, one delivery mechanism; gap trigger is a typed outcome (RESOLVED — was open)
Outbound posting has **two independent triggers** that MUST NOT be conflated, and **one** shared delivery path:
- **Automatic gap escalation = channel safety policy.** Fires when the turn's **typed outcome** is "no grounded answer" (the structured grounded-answer signal, e.g. retrieval producing `no_context`). It is enforced by a post-turn policy in the Slack channel and does **not** require the LLM or a routine to elect a Slack skill, nor pass through skill selection. It MUST NOT be derived from parsing the assistant's reply text (that would be both fragile and a violation of the repo's no-English-keyword-routing rule — Radioso is multilingual).
- **Routine-authored post = `slack` skill.** Deliberate lead/handoff posts authored in a routine, via the skill spine + `SlackEscalationExecutor`.
- **Shared delivery:** both enqueue the *same* outbox action type and resolve to the *same* handler + `SlackWebApiClient`; only the trigger differs.

**Plan obligation:** if the `ConnectorChatPort`/turn-result seam does not already surface a typed "grounded answer / no_context" outcome, the plan MUST add a narrow typed post-turn outcome field (the existing grounded-answer flag used by the quality view is the likely source). The connector channel reads that field; it never sniffs text.

## Reuse map (existing seams — path evidence)

The feature is mostly assembly of proven substrate. Precedent and seams found during scoping:

- **Inbound conversational channel precedent (clone target):** `backend/src/modules/connectors/plugins/whatsapp/` — `whatsappPlugin.ts` (mounts webhook via `ConnectorContext.http.mount`), `whatsappWebhook.ts` (GET challenge, POST event, HMAC verify with `timingSafeEqual` over raw body, dedupe via inbound message log, fast-ack, async processing). Slack swaps: `url_verification` POST challenge, `v0=` signing-secret signature over `v0:{ts}:{body}` + replay window, dedupe by `event_id`, bot-loop guard.
- **Connector substrate:** `packages/connector-api/connectorPlugin.d.ts` (`ConnectorPlugin`, `ConnectorContext` with `http`, `chat`, `state`, `db`); registry mounts at `/api/connectors/{connectorId}` (`connectors/services/connectorRegistry.ts`). `ingestion` port unused for a chat channel.
- **Turn entry (channel → engine):** `connectors/services/connectorChatPort.ts` → `ChatService.answer({ workspaceId, conversationId, query, stream:false, sourceChannel })` (`modules/chat/services/chatService.ts`); WhatsApp already passes `sourceChannel: "whatsapp"`. Conversation polymorphism: `conversations.source_channel` / `anonymousSessionId` (`db/repositories/conversationRepository.ts`).
- **OAuth substrate (install):** `modules/integrationOauth/public.ts` (PKCE, authorization URL, code exchange, refresh), `integration_oauth_connections` table (`db/migrations/095_integration_oauth_connections.sql`), provider registry + generic callback `GET /oauth/callback/:provider` (`app/http/routes/oauthConnectionRoutes.ts`), frontend `app/oauth/connections/callback/page.tsx`. Provider-registration precedent: customer-email Gmail/Outlook (`modules/customerEmail/oauthMailProviders.ts`, `modules/customerEmail/composition.ts`) reading client id/secret from env — **the exact template** for registering Slack as a provider. **Watch-out:** Slack's `oauth.v2.access` returns a non-standard token envelope (`{ok, access_token, team, authed_user, bot_user_id, ...}`); add a per-provider token-response normalizer rather than special-casing generic code.
- **Secret storage:** `shared/infra/crypto/fieldEncryption.ts` (AES-256-GCM) + `CONNECTOR_ENCRYPTION_KEY` (`app/config/env.ts`). Store the Slack bot token the same way connector/OAuth secrets are stored.
- **Escalation (outbound) — skill spine:** `agent_skills` spine (`db/migrations/099_agent_skills_spine.sql`, kinds `external_mcp`/`customer_email`/`webhook`) + unified `SkillExecutorPort` (`packages/conversation-defaults/src/skillExecutorRegistry.ts`); executors register by adapter key in `app/server/dependencyBuilders.ts`. Add a `slack` kind + `SlackEscalationExecutor`. Precedents: `modules/webhookSkills/`, `modules/customerEmail/executor/`.
- **Escalation delivery (reliability):** conversation-actions outbox — `routine_action_requests` (`db/migrations/072_routine_action_requests.sql`), `actionRequestRepository.ts` (idempotent enqueue, `claimPending` FOR UPDATE SKIP LOCKED), `ActionDispatcher`/`ActionDispatchWorker` (`modules/chat/services/actions/`), `ActionHandler` interface. Model the Slack post as a `slack.reply`/`slack.escalation` action handler. Outbound HTTP precedent with SSRF guard + retries: `webhookDelivery.ts` (`FetchWebhookHttpClient`).
- **Env config precedent for operator-level OAuth app creds:** `GOOGLE_MAIL_OAUTH_CLIENT_ID/SECRET`, `MICROSOFT_GRAPH_MAIL_OAUTH_CLIENT_ID/SECRET` in `app/config/env.ts`. Add `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.

## New code (the actual work, vs. reuse)

1. `slack` module: installation store (encrypted token by `team_id`), `SlackWebApiClient`, Slack OAuth provider definition + token-response normalizer, app-manifest generator.
2. Slack `ConnectorPlugin`: webhook (challenge + signature/replay + dedupe + loop guard + fast-ack), Slack identity → conversation mapping, reply.
3. `slack` skill kind + `SlackEscalationExecutor` + escalation action handler on the outbox dispatcher.
4. Frontend Slack settings: "Add to Slack" button, agent + escalation-channel pickers, self-host manifest panel.
5. Migrations: `slack_installations`, `slack_channel_bindings`, inbound event dedupe log; extend `agent_skills` kind check with `slack`.
6. Docs: Cloud + self-host setup, data-flow, curated-only stance.

## Open decisions (carry into planning)

- Reuse `integration_oauth_connections` for the Slack token vs. a dedicated `slack_installations` table. (Leaning dedicated, since the routing/agent-binding and `team_id` keying are Slack-specific; the OAuth *flow* still reuses the substrate.)
- Multi-agent per workspace: one Slack app per agent vs. one app routed by channel/binding. (Spec assumes one install → one answering agent + bindings.)

(Resolved: the escalation-trigger question is now D7 — typed gap outcome as channel policy, separate from the routine `slack` skill, both sharing one delivery handler.)

## Risks / dependencies

- **Cloud only:** building + maintaining a public, Slack-App-Directory-reviewed distributed app (scopes, privacy URL, review lead time). Does **not** apply to self-host (private app, no review). Code path is testable with a dev app before review completes.
- **Public reachability:** both OAuth callback and inbound events require the deployment to be reachable at a public HTTPS `APP_BASE_URL`. LAN-only self-host needs a tunnel/ingress.
- **Slack non-standard OAuth token envelope** — normalizer required (see Reuse map).
