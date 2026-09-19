# Visitors Module

Visitors owns the `visitors` entity: a workspace-scoped person as far as
Radioso can tell, keyed by a durable, client-persisted visitor key and/or a
host-verified customer id, with first/last seen, a conversation count, and the
latest observed country/language/user agent. It replaces a derived query over
`conversations.anonymous_session_id` / `verified_customer_id`.

**`visitor_key` is not a credential.** It is a client-generated uuid
(`crypto.randomUUID()` in the embed launcher, spec 1277 FR-008) persisted in
host-page `localStorage` purely so an operator sees one visitor across tabs
instead of several strangers. It grants no session, no resume, and no
history-read access — it is never bound into the signed public chat session
payload's trust boundary (`backend/src/modules/settings/domain/publicChatSession.ts`
keeps `publicSessionId` and `visitorKey` as separate claims for exactly this
reason). Anyone who learns another visitor's key can only make their own new
conversation show up grouped under that visitor's row for an operator — never
read or continue an existing one. See `services/visitorResolver.ts`'s class
doc for the full statement.

Start at `services/visitorResolver.ts`. `VisitorResolver` holds the only rules
that matter — a verified id beats a visitor key; an anonymous-only visitor
upgrades in place the first time it verifies; a later, *different* verified id
moves the conversation to that identity's own row without touching, or
re-attaching, the visitor key. The repository (`db/repositories/visitorRepository.ts`,
`VisitorRepository`) holds no rule — only named, transactional primitives
(find by key, insert-or-get, record an observation, move a conversation
between rows).

`public.ts` exposes `VisitorResolverPort` — `resolveForConversation` and
`attachVerifiedIdentity` — the only two operations `chat` depends on.
`composition.ts` is the application-wiring entry point; it re-exports the
concrete `VisitorRepository` and `VisitorResolver` for `backend/src/app/server/builders/chat.ts`
to instantiate. Neither the resolver nor the repository reads HTTP, headers,
geo, `process.env`, or an LLM; `ChatSessionPreparer` derives what to pass in
and persists the result.

`ChatSessionPreparer.prepare()` resolves a visitor before creating a new
conversation (skipped for `operator_test` conversations and for channels with
neither key, e.g. Slack or MCP without a session — FR-005) and calls
`attachVerifiedIdentity` at the same site that already calls
`setVerifiedCustomerId` on a conversation's first verified turn.

**Future constraint (FR-006):** there is no conversation-delete path in the
product today. If one is ever added, it must decrement the owning visitor's
`conversation_count` and delete a visitor that reaches zero — that bookkeeping
does not exist yet and is not exercised by anything in this module.

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/visitor-resolver.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/chat-session-preparer-visitor-resolution.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/visitor-resolver.integration.test.ts`

Spec: `specs/1277-visitor-profile/spec.md`.
