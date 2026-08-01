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

## Skills

A skill is a named capability a turn can run. Register the definitions with
`skills` and pair each name with a handler in `localSkills`; a handler receives the
resolved arguments and returns a settled outcome.

Two things pick the skill for a turn, in this order:

1. **Explicit metadata.** `metadata.skillName` (or `metadata.selectedSkills`) on the
   turn selects those skills. Your caller took the decision, so it wins.
2. **An authored directive binding.** Otherwise a matched directive whose `binding`
   names a registered skill claims the turn. This is the automatic path: behavior is
   authored ("when the user asks about an order, run `order_lookup`"), never a
   free-form model tool pick.

If neither applies, no skill runs and the turn composes an ordinary reply.

```ts
import { createConversationKit } from "@radioso/conversation-kit";

const kit = createConversationKit({
  openAiApiKey: process.env.OPENAI_API_KEY,
  skills: [{ name: "order_lookup", description: "Look up an order's status." }],
  localSkills: new Map([
    ["order_lookup", async ({ input }) => ({
      disposition: "settled",
      outcome: { status: "completed", outputs: { eta: "tomorrow", orderId: input.orderId } },
    })],
  ]),
  directives: [
    {
      name: "order_status",
      condition: { kind: "always" },
      action: "Answer with the order's status.",
      binding: { kind: "skill", skillName: "order_lookup" },
    },
  ],
});

const reply = await kit.runTurn({ sessionId: "s1", message: "Where is order A-1?" });
```

Routines run skills too. A `skill` step names the skill, `inputBindings` builds its
arguments from a literal, a routine variable (`variableRef`), or a turn context
variable (`contextVariableRef`), and `outputAssignments` stores result fields back
into routine variables — which `{{slot.<name>}}` in a later step's instruction reads.
The step is transit: the routine dispatches it and advances on the same turn,
including onto a failure edge when the skill fails or is not registered.

```ts
const runLookup = {
  id: "run_lookup",
  kind: "skill",
  skillName: "order_lookup",
  inputBindings: {
    orderId: { kind: "variableRef", ref: "orderId" },
    channel: { kind: "literal", value: "chat" },
  },
  outputAssignments: { eta: "eta" },
};
```

Pass `routineSkillDispatcher` to run routine skill steps through your own executor
instead of the local handlers.

## Routines

Routines are stateful, multi-step flows. The kit wires the routine runner and an
activator so authored routines actually run: pass `routineRegistrations` — each a
routine plus a host-owned `activates` predicate that decides when it starts (an
explicit signal, an LLM intent check, etc.; activation logic lives in your code,
not the engine). Once a routine is active the engine resumes it across turns until
it reaches a terminal step.

Clarification helpers are exported from the kit too: policy decision/stage
builders, the generic pending clarification resolver, clarifier/store contract
types, and the default routine-activation candidate mapper.

```ts
import { createConversationKit, type RoutineRegistration } from "@radioso/conversation-kit";

const signup: RoutineRegistration = {
  routine: {
    id: "signup",
    rootStepId: "ask_name",
    steps: [
      { id: "ask_name", kind: "chat", action: "Ask the user for their name." },
      { id: "done", kind: "terminal", action: "Thank the user and end." },
    ],
    transitions: [{ from: "ask_name", to: "done", condition: "the user provided their name" }],
  },
  trigger: {
    description: "The user wants to sign up.",
    priority: 0,
  },
};

const kit = createConversationKit({
  openAiApiKey: process.env.OPENAI_API_KEY,
  routineRegistrations: [signup],
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
