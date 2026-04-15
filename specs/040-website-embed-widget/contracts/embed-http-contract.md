# Website Embed HTTP Contract Notes

This feature continues to use the runtime code-first OpenAPI registry in `backend/src/app/http/openapi/document.ts` as the source of truth for backend HTTP contracts. The notes below capture the intended review surface before implementation.

## Settings contract additions

### `GET /api/v1/settings/general`

Extend the response with website-embed configuration fields:
- `websiteEmbedEnabled`
- `websiteEmbedScriptUrl`
- `websiteEmbedSnippet`
- `websiteEmbedAllowedOrigins`
- `websiteEmbedLauncherLabel`
- `websiteEmbedLauncherIcon`
- `websiteEmbedLauncherPosition`

### `PUT /api/v1/settings/general`

Extend the request body with website-embed operator settings:
- `websiteEmbedEnabled?: boolean`
- `websiteEmbedAllowedOrigins?: string[]`
- `websiteEmbedLauncherLabel?: string`
- `websiteEmbedLauncherIcon?: string`
- `websiteEmbedLauncherPosition?: string`

Rules:
- Enabling embed without at least one approved origin is rejected.
- Server owns token generation and install snippet generation.
- Existing anonymous chat and assistant bootstrap fields continue to round-trip unchanged.

## Public embed bootstrap contract

### `POST /api/v1/public/embed/:token/session`

Purpose:
- Validate that website embed is enabled for the workspace
- Validate the requesting origin against the workspace allowlist
- Issue a short-lived embed session grant for the hosted iframe

Request:
- No privileged credentials supplied by the host page
- Origin inferred from request headers and/or explicit launch payload validation
- Optional request-scoped locale hint if needed for first-turn initialization

Response:
- Success payload containing the minimum iframe bootstrap material needed to initialize the embedded chat
- User-friendly unavailable payload when embed is disabled or misconfigured
- Denied payload when the origin is not approved

Notes:
- Exact payload shape should remain minimal and avoid returning reusable secrets.
- If implementation can safely reuse an existing public-chat bootstrap route with a narrow extension, prefer that over creating a broader new contract.

## Hosted embed page contract

### `GET /embed/:token`

Purpose:
- Render the Radioso-hosted iframe shell for website embed launches

Notes:
- This is a frontend route rather than a backend API route, but its query or bootstrap requirements must stay aligned with the public embed session contract.
- The page should reuse the anonymous/public chat UI and startup behavior as much as possible.

## Existing public chat contract reuse

The existing public-chat endpoints remain the answer-generation and conversation-continuity backbone for embed:
- `POST /api/v1/public/chat/:token`
- `GET /api/v1/public/chat/:token`
- `GET /api/v1/public/chat/:token/history/:conversationId`

Implementation should prefer narrow extensions that preserve these routes and their current behavior rather than introducing an alternate chat contract for the embed channel.
