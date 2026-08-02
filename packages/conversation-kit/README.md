# @radioso/conversation-kit

Thin runnable wiring for the standalone conversation packages. It assembles the
conversation engine, default in-memory stores, default directive matching,
portable authoring stores, and a model gateway. It does not import the Radioso
backend, Postgres, Express, retrieval, auth, or billing code.

## Entry points

The root entry reaches no `node:*` builtin and no provider SDK, so it runs on any
runtime with ES modules — Node, Deno, Cloudflare Workers, the browser. Everything
that needs more than that sits behind its own subpath, and you pay for it only when
you import it.

| Import | What it gives you |
|---|---|
| `@radioso/conversation-kit` | The kit, the SDK client, authoring types, and the default ports. |
| `@radioso/conversation-kit/openai` | `createOpenAIModelGateway`, built on `@radioso/conversation-nlp`. |
| `@radioso/conversation-kit/server` | `createConversationKitServer`, the HTTP host, on `node:http`. |
| `@radioso/conversation-kit/node` | `FileConversationKitAuthoringStore`, which keeps authoring in a file. |

`@radioso/conversation-nlp` is an optional peer dependency: bring your own gateway
and the OpenAI SDK never enters your dependency tree. `tests/entryPoints.test.ts`
asserts what each entry point is allowed to load, so widening one is a deliberate
edit rather than an accident.

## Model provider

The kit needs a model, not a particular vendor. Pass `modelGateway` and it is used as
given — no API key is read and nothing vendor-specific runs:

```ts
import { createConversationKit } from "@radioso/conversation-kit";

const modelGateway = {
  async complete({ systemPrompt, messages, metadata }) {
    // Call whatever you run: another provider's SDK, a gateway, a local model.
    return { text: await yourModel(systemPrompt, messages), metadata };
  },
};

const kit = createConversationKit({ modelGateway });
```

For OpenAI, install `@radioso/conversation-nlp` and take the ready-made gateway:

```ts
import { createOpenAIModelGateway } from "@radioso/conversation-kit/openai";

const modelGateway = createOpenAIModelGateway({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5.2",
});
```

`model` is optional and falls back to `DEFAULT_OPENAI_MODEL`, exported from the same
subpath. Either way you end up with a plain gateway value, so it composes with
`createConversationKit`, `createConversationKitClient`, and
`createConversationKitServer` alike. The examples below take `modelGateway` from
here.

## Hello World

```ts
import { createConversationKitClient } from "@radioso/conversation-kit";

const client = createConversationKitClient({ modelGateway });

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
to keep agents, directives, and routines across process restarts. It lives on the
`/node` subpath because it is the one piece of the kit that needs a filesystem.

```ts
import { createConversationKitClient } from "@radioso/conversation-kit";
import { FileConversationKitAuthoringStore } from "@radioso/conversation-kit/node";

const authoringStore = new FileConversationKitAuthoringStore({
  path: "./conversation-authoring.json",
});

const client = createConversationKitClient({ authoringStore, modelGateway });

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

Any object satisfying `ConversationKitAuthoringStore` works here, so a host that
already has a database points the kit at that instead.

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
  modelGateway,
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

### Declared handler input

Give a turn-level skill a scalar field declaration when its handler needs facts
from the conversation. The kit extracts only those fields, validates them before
dispatch, and gives the handler canonical values. This keeps the parsing rule in
one multilingual model call instead of in every handler.

```ts
const kit = createConversationKit({
  modelGateway,
  skills: [{
    name: "book_haircut",
    inputSchema: {
      fields: [
        { name: "calendar_date", type: "date", required: true },
        {
          name: "haircut_style",
          type: "string",
          required: false,
          permittedValues: ["Short", "Long"],
        },
      ],
    },
  }],
  localSkills: new Map([
    ["book_haircut", async ({ input }) => {
      // input.calendar_date is YYYY-MM-DD; haircut_style is "Short" or "Long" when present.
      return { disposition: "settled", outcome: { status: "completed" } };
    }],
  ]),
});
```

When a required field is absent or rejected, the handler is not called. The turn
still gets a normal composed reply and its result includes `awaitingSkillInput`,
with the skill name, outstanding field declarations, choices, and whether each
field was absent or rejected. All selected skills wait: if one needs input, none
of them dispatch for that turn.

`awaitingSkillInput` is a report, not a saved engine state. An `always` directive
will select the skill again on the next turn and can recover the answer from the
conversation. A contextual directive may not match a bare reply, so a host that
needs guaranteed retry should retain the report and force the skill on its next
turn with selection metadata or `SelectedSkill.input`.

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
  modelGateway,
  routineRegistrations: [signup],
});
```

## Local Server

`createConversationKitServer` puts the same kit behind HTTP. It comes from the
`/server` subpath, which is where `node:http` enters the picture:

```ts
import { createConversationKitServer } from "@radioso/conversation-kit/server";

const server = createConversationKitServer({ kit });
const { url } = await server.listen({ host: "127.0.0.1", port: 8787 });
```

The bundled CLI does exactly that and builds the OpenAI gateway from the
environment, so it needs `@radioso/conversation-nlp` installed:

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
