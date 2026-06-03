# @radioso/conversation-kit

Thin runnable wiring for the standalone conversation packages. It assembles the
conversation engine, default in-memory stores, default directive matching,
portable authoring stores, and a model gateway. It does not import the Radioso
backend, Postgres, Express, retrieval, auth, or billing code.

## Hello World

```ts
import { createConversationKitClient } from "@radioso/conversation-kit";

const client = createConversationKitClient({
  openAiApiKey: process.env.OPENAI_API_KEY,
});

const agent = client.createAgent({
  name: "Hello World",
  instructions: ["Greet developers clearly."],
});

client.addDirective(agent.id, {
  name: "concise",
  condition: { kind: "always" },
  action: "Keep the answer concise.",
});

const session = client.createSession({ agentId: agent.id });
const reply = await client.sendMessage({
  sessionId: session.id,
  message: "Can you run without the Radioso backend?",
});

console.log(reply.answer);
```

## Authoring Persistence

The SDK uses a transient authoring store by default. Pass the file-backed adapter
to keep agents, directives, and routines across process restarts.

```ts
import {
  FileConversationKitAuthoringStore,
  createConversationKitClient,
} from "@radioso/conversation-kit";

const authoringStore = new FileConversationKitAuthoringStore({
  path: "./conversation-authoring.json",
});

const client = createConversationKitClient({
  authoringStore,
  openAiApiKey: process.env.OPENAI_API_KEY,
});

const agent = client.getAgent("agent_support") ?? client.createAgent({
  id: "agent_support",
  name: "Support",
});

client.createDirective(agent.id, {
  name: "tone",
  condition: { kind: "always" },
  action: "Use a calm support tone.",
});
```

## Local Server

```bash
OPENAI_API_KEY=sk-... pnpm --filter @radioso/conversation-kit exec radioso-conversation-kit serve
```

Then send a turn:

```bash
curl -s http://127.0.0.1:8787/turn \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello kit"}'
```

Create behavior through HTTP authoring, then run a turn against the authored
agent:

```bash
curl -s http://127.0.0.1:8787/agents \
  -H 'Content-Type: application/json' \
  -d '{"id":"agent_support","name":"Support"}'

curl -s http://127.0.0.1:8787/agents/agent_support/directives \
  -H 'Content-Type: application/json' \
  -d '{"name":"tone","condition":{"kind":"always"},"action":"Use a calm support tone."}'

curl -s http://127.0.0.1:8787/turn \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent_support","message":"Can you help?"}'
```
