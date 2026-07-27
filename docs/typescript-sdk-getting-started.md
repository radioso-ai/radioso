---
title: "Radioso TypeScript SDK: Getting Started"
description: "Installation and client setup guide for the Radioso TypeScript SDK with workspace API token authentication and a first request example."
last_updated: 2026-07-02
---

# Radioso TypeScript SDK: Getting Started

This guide shows how to install the SDK, configure a client, and make your first request.

## What You Need

- Node.js 24+
- A Radioso base URL
- An API token

The current SDK uses workspace API tokens. These are secret bearer credentials bound to one workspace. Public chat URLs and website embed launch values are not API tokens and cannot be used with the SDK.

## Install

If you are working in this repo:

```bash
cd typescript-sdk
pnpm install --filter @radioso/typescript-sdk...
pnpm run build
```

If you are consuming the built package from another project, point your package manager at the SDK package output or local package path.

## Create a Client

```ts
import { createRadiosoClient } from "@radioso/typescript-sdk";

const client = createRadiosoClient({
  baseUrl: "https://your-radioso-instance.example.com",
  apiToken: process.env.RADIOSO_API_TOKEN!,
});
```

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
