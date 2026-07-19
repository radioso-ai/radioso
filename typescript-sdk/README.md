# Radioso TypeScript SDK

In-repo SDK package for token-based Radioso integrations.

## Status

- v1 is token-first.
- Agent authoring (routines, directives, context variables, skills) is available with a workspace API token.
- Session-only and browser-admin workflows are out of scope.
- Workspace create/rename/delete stays session-authenticated and is not part of the SDK.
- The SDK contract snapshot is synced from `../backend/openapi.json` and `../backend/openapi.yaml`.

## Development

```bash
pnpm install --filter @radioso/typescript-sdk...
pnpm run sync
pnpm run test
pnpm run build
```

## Public Surface

- `createRadiosoClient({ baseUrl, apiToken })`
- `client.settings.getIngestion()`
- `client.settings.updateIngestion(...)`
- `client.settings.reprocessIngestion(...)`
- `client.settings.getGeneral()`
- `client.settings.updateGeneral(...)`
- `client.documents.list(...)`
- `client.documents.create(...)`
- `client.documents.importFile(...)`
- `client.documents.get(...)`
- `client.documents.update(...)`
- `client.documents.delete(...)`
- `client.documents.search(...)`
- `client.documents.listHistory(...)`
- `client.documents.getHistory(...)`
- `client.documents.reprocess(...)`
- `client.documents.reprocessSource(...)`
- `client.chat.create(...)`
- `client.chat.listHistory(...)`
- `client.chat.getHistoryConversation(...)`
- `client.chat.stream(...)`

### Agent authoring

- `client.agents.routines.*` — list, get, create, update, delete, archive, restore, publish, revise, validate, draftAssist, and the portable-markdown round-trip (`getPortable`, `updatePortable`, `createPortable`, `skillCatalog`)
- `client.routines.canonicalizePortable(...)` — normalize a portable routine document without saving it
- `client.agents.directives.*` — list, draft, create, update, delete
- `client.agents.contextVariables.*` — list, upsert, delete, getSigningKey (per-agent enablement)
- `client.contextVariables.*` — list, create, get, update, delete, getValue, upsertValue, deleteValue (workspace definitions and values)
- `client.agents.skills.*` and `client.agents.{emailSkills,externalSkills,webhookSkills,slackSkills}.*` — skill bindings per capability
- `client.agents.mcpConnections.*` and `client.agents.mcpConverseGrants.*` — external MCP connections and converse grants

## Contract Refresh

1. Regenerate backend OpenAPI artifacts from the code-first registry.
2. Run `pnpm run sync` in `typescript-sdk/`.
3. Review the synced OpenAPI snapshot and generated SDK types.
4. Run SDK tests before release.
