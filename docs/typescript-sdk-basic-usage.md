# Radioso TypeScript SDK: Basic Usage

This guide covers the main things you are likely to do first with the SDK.

## Setup

```ts
import { createRadiosoClient, RadiosoError } from "@radioso/typescript-sdk";

const client = createRadiosoClient({
  baseUrl: "https://your-radioso-instance.example.com",
  apiToken: process.env.RADIOSO_API_TOKEN!,
});
```

## Documents

List documents:

```ts
const documents = await client.documents.list({ limit: 20 });
```

Create a document:

```ts
const queued = await client.documents.create({
  title: "FAQ",
  content: "Radioso can answer questions about uploaded content.",
  metadata: {
    category: "support",
    published: true,
  },
});
```

Fetch a document:

```ts
const document = await client.documents.get("document-id");
```

Update a document:

```ts
await client.documents.update("document-id", {
  title: "FAQ v2",
  content: "Updated content",
  metadata: {
    category: "support",
    version: 2,
  },
});
```

Delete a document:

```ts
await client.documents.delete("document-id");
```

Search documents:

```ts
const search = await client.documents.search({
  query: "answers about uploaded content",
});
```

## Non-Streaming Chat

```ts
const response = await client.chat.create({
  query: "What does the FAQ say about uploaded content?",
  stream: false,
});
```

## Streaming Chat

`client.chat.stream()` returns events one at a time. Check `event.type` and handle each case.

```ts
for await (const event of client.chat.stream({
  query: "Summarize the FAQ",
})) {
  if (event.type === "conversation") {
    continue;
  }

  if (event.type === "chunk") {
    continue;
  }

  if (event.type === "done") {
    continue;
  }

  if (event.type === "error") {
    throw event.error;
  }
}
```

## Error Handling

The SDK turns request failures into `RadiosoError`, so you can handle them in one place.

```ts
try {
  await client.documents.list();
} catch (error) {
  if (error instanceof RadiosoError) {
    if (error.status === 401) {
      // refresh or replace the API token
    }
  } else {
    throw error;
  }
}
```

## Notes

- `baseUrl` should be the Radioso server origin, without a trailing slash.
- The SDK sends the API token as `Authorization: Bearer <token>`.
- Streaming chat is layered on top of the same `/api/v1/chat/` endpoint, with `stream: true`.
- Run `npm run sync` in [`typescript-sdk/`](/Users/dm/conductor/workspaces/radioso/typescript-sdk/typescript-sdk) after backend API changes so the generated types stay up to date.
- Search and answer settings are documented separately in [Retrieval Settings](./typescript-sdk-retrieval-settings.md).
