# Quickstart: Chat Route Citations

## Prerequisites

- Frontend dependencies installed in `/private/tmp/radioso-chat-frontend-routes/frontend`
- Backend running with a valid API token flow and at least one processed document

## Validation Flow

1. Start the frontend and backend in the feature worktree.
2. Authenticate through the existing login or registration flow.
3. Confirm the browser moves from `/` to `/account/<accountId>/chat`.
4. Navigate using the sidebar and confirm the URL changes for:
   - `/account/<accountId>/chat`
   - `/account/<accountId>/documents`
   - `/account/<accountId>/settings`
   - `/account/<accountId>/token`
5. Open a document from the documents list and confirm the URL becomes `/account/<accountId>/documents/<documentId>`.
6. Refresh the open-document URL and confirm the same document reopens after auth bootstrap.
7. Return to chat, ask a question that cites at least one document, and confirm:
   - assistant text begins rendering before the request completes
   - inline citation markers appear within the message content instead of a separate sources footer
   - hovering or focusing a citation reveals the cited document title
   - clicking a citation opens `/account/<accountId>/documents/<documentId>`
8. Use browser back and confirm the prior chat conversation remains visible.
9. Run frontend lint and build validation before handoff.

## Expected Result

- All dashboard destinations are deep-linkable by account-scoped routes.
- Document routes are refresh-safe.
- Chat uses the backend stream when available and degrades cleanly if streaming fails.
- Inline citations remain navigable and titled without exposing cross-account data.

## Validation Notes

- `npm install` succeeded in `/private/tmp/radioso-chat-frontend-routes/frontend`.
- `npm run lint` succeeded in `/private/tmp/radioso-chat-frontend-routes/frontend`.
- `npm run build` succeeded in `/private/tmp/radioso-chat-frontend-routes/frontend`.
- `npx tsc --noEmit` succeeded in `/private/tmp/radioso-chat-frontend-routes/frontend`.
- `npm install` emitted non-blocking engine warnings because the current shell uses Node `21.7.3` while some packages prefer `18`, `20`, or `>=22`.
