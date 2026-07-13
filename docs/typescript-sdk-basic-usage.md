---
title: "Radioso TypeScript SDK: Basic Usage"
description: "SDK tutorial covering documents, settings, skills, agents, chat, streaming, history, and error handling patterns."
last_updated: 2026-07-02
---

# Radioso TypeScript SDK: Basic Usage

This guide covers the main things you are likely to do first with the SDK.

## Migration Note: Debug Responses

Version 0.2.0 changes assistant, retrieval search, retrieval answer, and document search diagnostics to be opt-in. Calls that previously read `route`, `activitySummary`, `activityTrace`, or retrieval answer `evidence` from top-level response fields should pass `includeDebug: true` where the endpoint supports it and read those values from `response.debug`. Normal user-facing fields such as `answer`, `citations`, and search results stay at the top level.

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
  source: {
    kind: "website",
    url: "https://example.com/docs",
  },
  metadata: {
    category: "support",
    published: true,
  },
});
```

Import a file:

```ts
import { readFile } from "node:fs/promises";

const file = await readFile("./handbook.pdf");

const imported = await client.documents.importFile({
  file,
  filename: "handbook.pdf",
  title: "Support handbook",
  mimeType: "application/pdf",
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

List document search history:

```ts
const history = await client.documents.listHistory({ limit: 10 });
```

Replay one historical search:

```ts
const replay = await client.documents.getHistory("search-id");
```

Reprocess a document:

```ts
await client.documents.reprocess("document-id");
```

Force enrichment for a single reprocess run:

```ts
await client.documents.reprocess("document-id", {
  documentEnrichmentOverride: "on",
});
```

Reprocess all eligible documents for one source:

```ts
await client.documents.reprocessSource("source-id", {
  documentEnrichmentOverride: "on",
});
```

## Settings

Read ingestion settings:

```ts
const ingestion = await client.settings.getIngestion();
```

Update ingestion settings:

Supported chunking strategies are `"fixed_window"`, `"structured_semantic"`, and `"recursive_text"`.

```ts
await client.settings.updateIngestion({
  chunkingStrategy: "fixed_window",
  fixedWindowChunkSize: 800,
  fixedWindowChunkOverlap: 120,
  structuredMinChunkSize: 400,
  structuredMaxChunkSize: 1200,
  documentEnrichmentEnabled: true,
});
```

Queue workspace-wide reprocessing after an ingestion change:

```ts
await client.settings.reprocessIngestion();
```

Workspace reprocessing also accepts a one-run enrichment override:

```ts
await client.settings.reprocessIngestion({
  documentEnrichmentOverride: "off",
});
```

Read general settings:

```ts
const general = await client.settings.getGeneral();
```

Update general settings:

```ts
await client.settings.updateGeneral({
  anonymousChatEnabled: true,
});
```

## Skills

The SDK exposes the read-only product skills catalog. Agent-authored skills use
the agent skills REST endpoints until the generated SDK surface is promoted.
Those agent skills are named capability instances such as `retrieve`, `email`,
`slack_post`, `webhook_call`, `mcp_tool`, and `notify`.

List skills:

```ts
const catalog = await client.skills.list();
```

Read one catalog skill:

```ts
const retrievalAnswer = await client.skills.get("retrieval.answer");
console.log(retrievalAnswer.contractReferences);
```

To author an agent skill over REST:

```ts
const capabilities = await fetch(`/api/v1/agents/${agentId}/skill-capabilities`);
const created = await fetch(`/api/v1/agents/${agentId}/skills`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "send_followup",
    capability: "email",
    target: { kind: "customer_email_connection", id: connectionId },
    config: {
      mode: "draft",
      exposedInputs: { to: { slotBinding: "email" }, bodyText: { slotBinding: "message" } },
      boundInputs: { subject: "Follow-up" },
    },
    invocationMode: "routine_named",
    enabled: true,
  }),
});
```

Retrieval answer settings now live on the default-answer `retrieve` skill.
Suggested questions are part of that skill's config. Contact escalation is a
`notify` skill, and routine completion export is a `webhook_call` skill.

Temporal retrieval fields such as `temporalStructuredLookupEnabled`, `temporalBoostUpcomingEnabled`, and `temporalDeterministicSortEnabled` are per-agent `retrieval.answer` skill settings. They default to on and control date-aware event lookup, boosting, and ordering when enriched chunks contain `dateFrom` and `dateTo` metadata.

Retrieval answer responses are lean by default. When you need diagnostics, pass `includeDebug: true` through the REST contract. The response then includes `debug.evidence`, `debug.activityTrace`, and `debug.activitySummary`. Check `debug.activitySummary.shapeName`, `debug.activitySummary.queryShape`, `debug.activitySummary.resolvedSteps`, and the `shape_selection` stage to see how the answer was retrieved.

## Agents

Each workspace has a default agent. Chat calls use that agent when `agentId` is omitted.

List agents:

```ts
const agents = await client.agents.list();
const defaultAgent = agents.agents.find((agent) => agent.isDefault);
```

Create a direct-only agent:

```ts
const direct = await client.agents.create({
  name: "Direct support",
  customInstruction: "Answer from the configured instructions. Do not cite documents.",
  retrievalEnabled: false,
});
```

Use a specific agent in chat:

```ts
const response = await client.chat.create({
  agentId: direct.id,
  message: "How should I answer a general support question?",
  stream: false,
});
```

Agents use the retrieval pipeline through their default-answer `retrieve` skill.
Edit that skill to configure retrieval behavior for one agent. Omitted fields
inherit system/model defaults, and the dashboard shows those inherited values
inline before saving only explicit overrides. Direct-only agents answer from their own
instructions and return retrieval diagnostics with `retrievalInvoked: false`.

## Non-Streaming Chat

SDK chat methods target the assistant chat surface. Use them for human-facing assistant conversations that should keep history and may answer directly or with retrieval-backed evidence.

```ts
const response = await client.chat.create({
  message: "What does the FAQ say about uploaded content?",
  stream: false,
});

console.log(response.answer);
```

## Streaming Chat

`client.chat.stream()` returns events one at a time. Check `event.type` and handle each case.

```ts
for await (const event of client.chat.stream({
  message: "Summarize the FAQ",
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

List chat history:

```ts
const conversations = await client.chat.listHistory({ limit: 20 });
```

Fetch one historical conversation:

```ts
const conversation = await client.chat.getHistoryConversation("conversation-id", { limit: 50 });
```

Read the latest conversation after listing history:

```ts
const recent = await client.chat.listHistory({ limit: 10 });
const latest = recent.conversations[0];

if (latest) {
  const detail = await client.chat.getHistoryConversation(latest.id);
  console.log(detail.messages);
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
- The SDK sends the workspace API token as `Authorization: Bearer <token>`.
- Public chat and website embed launch credentials are intentionally public and are not accepted as SDK API tokens.
- Streaming chat is layered on top of the assistant chat contract, `POST /api/v1/assistant/chat`, with `stream: true`.
- Skill discovery is exposed through `client.skills.list()` and `client.skills.get(name)`. The catalog describes current assistant, retrieval, document, and MCP contracts; it does not execute skills directly.
- Retrieval-only clients should use the REST retrieval surfaces, `POST /api/v1/retrieval/search` and `POST /api/v1/retrieval/answer`, when they do not want assistant persona or assistant-owned chat history. Pass `includeDebug: true` when callers need shape, resolved-step diagnostics, or retrieval answer evidence. Callers do not select shapes directly.
- Shared workspace settings are exposed by the REST platform settings resource, `GET /api/v1/settings` and `PUT /api/v1/settings`, with assistant and channel settings. Ingestion settings are exposed separately through the settings API.
- Workspace creation, rename, and deletion are not exposed because those routes are currently session-authenticated rather than token-authenticated.
- Run `pnpm run sync` in [`typescript-sdk/`](../typescript-sdk/) after backend API changes so the generated types stay up to date.
