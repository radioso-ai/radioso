# Radioso TypeScript SDK: Getting Started

This guide shows how to install the SDK, configure a client, and make your first request.

## What You Need

- Node.js 22+
- A Radioso base URL
- An API token

The current SDK uses API tokens. It does not cover browser sign-in or admin-only actions.

## Install

If you are working in this repo:

```bash
cd typescript-sdk
npm install
npm run build
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

From [`typescript-sdk/`](/Users/dm/conductor/workspaces/radioso/typescript-sdk/typescript-sdk):

```bash
npm run sync
npm run test
npm run build
```

`npm run sync` updates the SDK's generated types from the backend API description.

## What You Can Do With It Right Now

```ts
client.settings.getRetrieval(...)
client.settings.updateRetrieval(...)
client.settings.getIngestion(...)
client.settings.updateIngestion(...)
client.settings.reprocessIngestion()
client.settings.getGeneral(...)
client.settings.updateGeneral(...)

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

client.chat.create(...)              // assistant chat
client.chat.listHistory(...)
client.chat.getHistoryConversation(...)
client.chat.stream(...)
```

## Next Step

Continue with [Basic Usage](./typescript-sdk-basic-usage.md) for copy-paste examples of documents, chat, streaming, and error handling.
For search and answer settings, use [Retrieval Settings](./typescript-sdk-retrieval-settings.md). For retrieval-only answers without assistant behavior, call the REST retrieval endpoints directly: `POST /api/v1/retrieval/search` and `POST /api/v1/retrieval/answer`.
