# Research: Anonymous Chat Access

## R-001: Anonymous Session Identity Mechanism

**Decision**: Use an HTTP-only cookie containing a UUID session token to identify anonymous users. The backend generates the token on first visit and sets it as a cookie. Subsequent requests include the cookie automatically.

**Rationale**: Cookies are the simplest mechanism for persistent browser identity. HTTP-only prevents XSS theft. The existing codebase already uses cookies for authenticated sessions (`SESSION_COOKIE_NAME`), so the pattern is familiar. No client-side token management needed.

**Alternatives considered**:
- **localStorage + header**: Requires frontend JS to attach token on every request. More complex, no benefit over cookies for this use case.
- **Fingerprinting**: Privacy-invasive, unreliable, unnecessary given the spec says cookies are sufficient.
- **IP-based**: Unreliable behind NATs/VPNs, not suitable for user distinction.

## R-002: Public URL Token Format

**Decision**: Each workspace gets a deterministic public chat slug derived from a random URL-safe token (generated once when anonymous chat is first enabled, stored in the workspace settings). Format: `/chat/<token>` where token is a 22-character base64url string (128 bits of entropy).

**Rationale**: 128 bits is sufficient to prevent brute-force enumeration. Deterministic per workspace (not per-session) so the admin shares one stable URL. Storing the token in workspace settings keeps it simple — no new table needed. The token is regenerated only if the admin explicitly requests it.

**Alternatives considered**:
- **Workspace UUID in URL**: Exposes internal IDs, allows enumeration.
- **Per-session unique URLs**: Overcomplicates sharing; admin wants one link to hand out.
- **Signed JWT in URL**: Overcomplicated for a simple lookup.

## R-003: Where to Store the anonymous_chat_enabled Flag

**Decision**: Add a new `workspace_settings` table (or extend the existing `workspaces` table with an `anonymous_chat_enabled` boolean and `anonymous_chat_token` text column). Given the current architecture uses a dedicated `retrieval_settings` table for workspace-scoped settings, and the new setting is general (not retrieval-specific), the cleanest approach is to add columns directly to the `workspaces` table via a new migration.

**Rationale**: The `workspaces` table already holds workspace-level config. Adding two columns (`anonymous_chat_enabled BOOLEAN DEFAULT false`, `anonymous_chat_token TEXT`) is simpler than creating an entirely new settings table for just two fields. The retrieval_settings table is domain-specific and shouldn't absorb unrelated concerns.

**Alternatives considered**:
- **New `general_settings` table**: Clean separation but premature — only two fields. Can extract later if general settings grow.
- **Add to `retrieval_settings`**: Violates single responsibility; retrieval settings shouldn't own access control.
- **JSON config column on workspaces**: Flexible but loses type safety and queryability.

## R-004: Anonymous Chat Route Architecture

**Decision**: Create a new Express route file `publicChatRoutes.ts` mounted at `/api/v1/public/chat/:token`. This route bypasses `requireApiToken` and instead uses a new `resolveAnonymousSession` middleware that:
1. Looks up the workspace by the URL token
2. Verifies `anonymous_chat_enabled` is true
3. Reads/creates the anonymous session cookie
4. Sets `res.locals.workspaceId` and `res.locals.anonymousSessionId`

The route handler then delegates to the existing `ChatService` (same as authenticated chat).

**Rationale**: Keeps authenticated and anonymous routes cleanly separated. Reuses ChatService for actual chat logic (DRY). The middleware pattern matches existing `requireApiToken` / `requireSession` patterns.

**Alternatives considered**:
- **Flag on existing chat route**: Muddies the auth middleware, violates the spec's anti-goal.
- **Separate microservice**: Over-engineering for this scope.

## R-005: Frontend Public Chat Page

**Decision**: Create a new Next.js route at `/chat/[token]/page.tsx` that sits outside the `/account/[accountId]` layout (no sidebar, no auth guard). This page imports and renders the existing `ChatView` component, providing it with an anonymous-specific context provider that handles the public API calls and cookie-based session.

**Rationale**: Reuses all chat UI components (message list, input, citations, streaming). Only the page shell and data-fetching context differ. Keeps DRY per spec requirement.

**Alternatives considered**:
- **Embed chat in iframe**: Poor UX, complicated cookie handling.
- **Duplicate chat components**: Violates DRY anti-goal in spec.

## R-006: Conversation Ownership for Anonymous Users

**Decision**: Anonymous conversations use the existing `conversations` and `messages` tables. The `conversations` table already has a `source_channel` column. Set `source_channel = 'anonymous'` for anonymous conversations. Additionally, store the anonymous session ID in a new `anonymous_session_id` column on `conversations` so the system can filter conversations by anonymous user cookie.

**Rationale**: Reuses existing tables. The `source_channel` field provides a natural way to distinguish anonymous from authenticated conversations in queries and UI. Adding `anonymous_session_id` enables per-user conversation history lookup without a new join table.

**Alternatives considered**:
- **New `anonymous_conversations` table**: Duplicates schema, complicates history queries.
- **Store session ID in source_channel**: Overloads the field's meaning.

## R-007: Rate Limiting Strategy for Anonymous Chat

**Decision**: Use an in-memory sliding window counter keyed by `anonymousSessionId`. The middleware checks the counter before allowing the message through to `ChatService`. The limit (messages per minute) is read from `workspaces.anonymous_rate_limit` at request time, so admin changes take effect immediately.

**Rationale**: In-memory rate limiting is simple, fast, and sufficient for a single-instance deployment. The counter resets naturally as entries expire. No external dependency (Redis) needed. Per-session limiting (not per-IP) aligns with the cookie-based identity model and prevents one user from burning the quota of others.

**Alternatives considered**:
- **Redis-based rate limiter**: Production-grade but adds infrastructure dependency. Can migrate later if needed for multi-instance deployments.
- **Database-based counting**: Too slow for per-request checks; adds write load.
- **Per-IP rate limiting**: Unreliable behind shared IPs/NATs; punishes multiple legitimate users on the same network.
- **Global (all sessions combined) rate limit**: Unfair — one heavy user blocks everyone. Per-session is more equitable.
