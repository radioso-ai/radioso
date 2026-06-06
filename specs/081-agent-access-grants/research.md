# Agent Access Grants Research

## Migration strategy

Existing public launch credentials live on agent JSONB surface settings:

- `surfaceSettings.anonymousChat.token`
- `surfaceSettings.websiteEmbed.token`
- `surfaceSettings.websiteEmbed.allowedOrigins`

The US1 migration creates `agent_access_grants` and backfills one `public-launch` grant per non-null legacy token. Anonymous-chat grants use `origin_mode = 'allow-all'` because anonymous links are not browser-origin constrained today. Website-embed grants use `origin_mode = 'list'` and copy the normalized existing `allowedOrigins` array; an empty list remains allow-none at the grant layer, preserving the existing "embed needs approved origins" behavior.

Backfill is idempotent by inserting from distinct agent/token pairs with `ON CONFLICT (token_hash) DO NOTHING`. It does not delete or rewrite the legacy JSONB token fields in this MVP, so existing clients and generated snippets continue to see the same launch value. Runtime code reads grants first and falls back to legacy token fields when the grant table is not yet populated.

## Message-queue impact review

Reviewed the document worker dispatch and AMQP code paths referenced by the plan:

- `backend/src/modules/documents/composition.ts`
- `backend/src/db/repositories/documentProcessingJobRepository.ts`
- `backend/src/modules/documents/services/documentProcessingWorker.ts`
- `backend/src/app/server/dependencyBuilders.ts`

Document-processing jobs carry job IDs, workspace/document identifiers, and worker routing metadata. They do not carry website embed tokens, anonymous-chat tokens, API bearer tokens, MCP tokens, or channel credentials. US1 changes public launch credential persistence and public session exchange only; no document-worker payload shape, AMQP routing key, retry semantics, or queue docs need updates for this slice.

US3 represents allow-all website embed origins as `*` inside `websiteEmbedAllowedOrigins`. This channel setting remains HTTP/JSONB configuration only. It is not included in document worker dispatch payloads, AMQP messages, retry metadata, or queue routing, so the message-queue impact remains none for this slice.

## Secret hashing and encryption reuse

Workspace admin tokens currently use:

- `generateApiToken()` for random token material
- `tokenPrefix()` for the stable `radioso_` prefix
- `sha256(token)` for lookup hashes
- `encryptSecret(token, WORKSPACE_TOKEN_SECRET)` for recoverable one-value compatibility storage
- `decryptSecret(encryptedToken, WORKSPACE_TOKEN_SECRET)` when an existing token must be shown

Access grants reuse those primitives and the same `WORKSPACE_TOKEN_SECRET` root. Grant secrets are stored as `token_hash` and `encrypted_token`; plaintext is returned only when issuing or rotating a grant and is never logged or stored outside the encrypted column.
