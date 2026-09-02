---
title: "Radioso TypeScript SDK: Getting Started"
description: "Installation and client setup guide for role-aware workspace automation with the Radioso TypeScript SDK."
last_updated: 2026-09-01
---

# Radioso TypeScript SDK: Getting Started

This guide shows how to install the SDK, configure a client, and make your first request.

## What You Need

- Node.js 24+
- A Radioso base URL
- A personal token or service-account credential

Use a personal token when the client should act as your current workspace membership; it must expire within 90 days. Use a service-account credential for a stable CI or server identity; each credential must expire within 365 days. Both are secret bearer credentials bound to one workspace and a live role. Public chat, website embed, and role-free agent channel credentials are separate credential classes and cannot be used with this SDK client.

Create a personal token from the workspace API access controls, or create the non-human identity under **Settings → Service accounts**, in a signed-in browser. Radioso returns the secret once, so store it in a secret manager rather than browser storage or source code.

To expose one agent as a chat channel, create a separate credential from **Channels → API** or **Channels → MCP**. A REST-audience credential calls `POST /api/v1/agents/{agentId}/chat`; an MCP-audience credential reaches `ask_agent`. These credentials have no workspace role.

## Install

```bash
npm install @radioso/typescript-sdk
```

To work on the SDK itself in this repo instead of installing the published package:

```bash
cd typescript-sdk
pnpm install --filter @radioso/typescript-sdk...
pnpm run build
```

## Create a Client

```ts
import { createRadiosoClient } from "@radioso/typescript-sdk";

const client = createRadiosoClient({
  apiToken: process.env.RADIOSO_API_TOKEN!,
});
```

`createRadiosoClient` talks to `https://api.radioso.ai` by default, exported as `DEFAULT_BASE_URL`. Set `baseUrl` when your workspace lives somewhere else:

- `https://api.radioso.ai` — the default, EU-hosted instance
- `https://api-us.radioso.ai` — the US-hosted instance
- your own origin, for a self-hosted deployment (for example `https://radioso.acme.com`)

An API credential only works against the instance that issued it, so `baseUrl` has to match wherever that workspace's data actually lives.

## First Request

This example lists documents available to that token.

```ts
const documents = await client.documents.list({ limit: 10 });
```

## Common Development Commands

From [`typescript-sdk/`](../typescript-sdk/):

```bash
pnpm run sync
pnpm run test
pnpm run build
```

`pnpm run sync` updates the SDK's generated types from the backend API description.

## What You Can Do With It

```ts
client.settings.getIngestion(...)
client.settings.updateIngestion(...)
client.settings.reprocessIngestion()
client.settings.getGeneral(...)
client.settings.updateGeneral(...)

client.workspace.getSummary()
client.skills.list(...)
client.skills.get(...)
client.agents.list(...)
client.agents.create(...)
client.agents.get(...)
client.agents.update(...)
client.agents.setDefault(...)

client.documents.list(...)
client.documents.create(...)
client.documents.importFile(...)
client.documents.get(...)
client.documents.update(...)
client.documents.delete(...)
client.documents.search(...)
client.documents.listHistory(...)
client.documents.getHistory(...)
client.documents.reprocess(...)
client.documents.reprocessSource(...)

client.history.list(...)
client.history.listChats(...)
client.history.listSearches(...)
client.history.getChat(...)
client.history.getSearch(...)

client.chat.create(...)              // assistant chat
client.chat.listHistory(...)
client.chat.getHistoryConversation(...)
client.chat.stream(...)
```

## Next Step

Continue with [Basic Usage](./typescript-sdk-basic-usage.md) for copy-paste examples of documents, chat, streaming, and error handling.
For retrieval-only answers without assistant behavior, call the REST retrieval endpoints directly: `POST /api/v1/retrieval/search` and `POST /api/v1/retrieval/answer`.
