# Radioso TypeScript SDK

Talk to a Radioso agent from TypeScript or JavaScript, and author what it runs under — the directives that steer it, the routines that carry a flow across turns, the skills it dispatches, and the documents it answers from. One typed client, authenticated with a workspace API token.

## Install

```bash
npm install @radioso/typescript-sdk
```

Requires Node.js 24 or later. The package has no runtime dependencies.

## Quickstart

```ts
import { createRadiosoClient } from "@radioso/typescript-sdk";

const client = createRadiosoClient({
  apiToken: process.env.RADIOSO_API_TOKEN!,
});

const documents = await client.documents.list({ limit: 10 });
```

`createRadiosoClient` talks to `https://api.radioso.ai` by default, exported as `DEFAULT_BASE_URL`. Pass `baseUrl` when your workspace lives somewhere else:

- `https://api.radioso.ai` — the default, EU-hosted instance
- `https://api-us.radioso.ai` — the US-hosted instance
- your own origin, for a self-hosted deployment (for example `https://radioso.acme.com`)

A workspace API token only works against the instance that issued it, so `baseUrl` has to match wherever that workspace's data actually lives.

## Status

- v1 is token-first.
- Agent authoring (routines, directives, context variables, skills) is available with a workspace API token.
- Session-only and browser-admin workflows are out of scope.
- Workspace create/rename/delete stays session-authenticated and is not part of the SDK.
- The SDK contract snapshot is synced from `../backend/openapi.json` and `../backend/openapi.yaml`.

## Versioning

The SDK follows semver against its own `client.*` surface, independent of the backend API version. The OpenAPI snapshot shipped in the package (`openapi/radioso.json`) records exactly which backend contract that SDK version was generated against. Releases are cut by pushing a git tag `typescript-sdk-v<version>`.

## Development

These commands are for contributors working on the SDK inside this repo. `pnpm run sync` refreshes the contract snapshot from `../backend/openapi.*`; commit the result, because the published package builds from the committed snapshot.

```bash
pnpm install --filter @radioso/typescript-sdk...
pnpm run sync
pnpm run test
pnpm run build
```

## Public Surface

- `createRadiosoClient({ baseUrl, apiToken })`

### Conversation

- `client.chat.create(...)`
- `client.chat.stream(...)`
- `client.chat.listHistory(...)`
- `client.chat.getHistoryConversation(...)`

### Agent authoring

- `client.agents.routines.*` — list, get, create, update, delete, archive, restore, publish, revise, validate, draftAssist, and the portable-markdown round-trip (`getPortable`, `updatePortable`, `createPortable`, `skillCatalog`)
- `client.routines.canonicalizePortable(...)` — normalize a portable routine document without saving it
- `client.agents.directives.*` — list, draft, create, update, delete
- `client.agents.contextVariables.*` — list, upsert, delete, getSigningKey (per-agent enablement)
- `client.contextVariables.*` — list, create, get, update, delete, getValue, upsertValue, deleteValue (workspace definitions and values)
- `client.agents.skills.*` and `client.agents.{emailSkills,externalSkills,webhookSkills,slackSkills}.*` — skill bindings per capability
- `client.agents.mcpConnections.*` and `client.agents.mcpConverseGrants.*` — external MCP connections and converse grants

### Documents and settings

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
- `client.settings.getIngestion()`
- `client.settings.updateIngestion(...)`
- `client.settings.reprocessIngestion(...)`
- `client.settings.getGeneral()`
- `client.settings.updateGeneral(...)`

## Contract Refresh

1. Regenerate backend OpenAPI artifacts from the code-first registry.
2. Run `pnpm run sync` in `typescript-sdk/`.
3. Review the synced OpenAPI snapshot and generated SDK types.
4. Run SDK tests before release.
