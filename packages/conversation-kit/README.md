# @radioso/conversation-kit

Thin runnable wiring for the standalone conversation packages. It assembles the
conversation engine, default in-memory stores, default directive matching, and a
model gateway. It does not import the Radioso backend, Postgres, Express,
retrieval, auth, or billing code.

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
