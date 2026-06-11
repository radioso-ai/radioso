# Authoring Routines

A routine is a multi-step flow your agent runs across several turns: it collects
what a task needs, takes an action, and confirms. You build a routine as data, in
the agent's settings — no code or redeploy.

For the concepts behind routines, see
[Conversational routines](./architecture/conversational-routines.md). This page is
about building one.

## Where to author

Open an agent and go to **Routines** in the settings. The page lists the agent's
routines and lets you create a new one. The same actions are available over the
API under `/api/v1/agents/<agentId>/routines`.

## Building a routine

A routine has a name, an activation trigger, and four parts you fill in.

### Activation

The **trigger** describes, in plain language, when the routine should start —
for example, "the user wants a person to follow up with them." The model judges
the trigger by meaning, so it works in any language. If two routines could start
on the same message, the one with the higher **priority** wins.

### Slots

Slots are the values the routine collects, such as an email or an order number.
For each slot, set a key, a type (text, number, boolean, email, or date), and
whether it is required. Reference a slot inside a step or terminal with
`{{slot.<key>}}`; at run time it is replaced with the value collected so far. Only
reference a slot once it has been collected — for example in a confirmation. A
reference to a slot the routine has not captured yet resolves to nothing, so do not
use `{{slot.<key>}}` in the step that asks for it (just describe what to ask).

### Steps

Steps are the units of the flow. Two kinds are available:

- A **chat** step asks the user for something or tells them something. Write the
  instruction in plain language; the assistant turns it into a reply.
- An **action** step fires a side effect — for example, submitting a contact
  request. Pick the action type. You can only use an action your agent is
  permitted to use; the page rejects one it is not.

If a user supplies several values in one message, the routine can advance through
several steps at once instead of asking for each in turn.

### Transitions and guards

A transition connects one step to the next. Its **guard** decides when the edge is
taken:

- `always` — go to the next step unconditionally.
- `slot_filled` — go once the named slots are present.
- `outcome` — branch on the result of the preceding action.
- `counter` — go once a step has been tried a set number of times (for "try
  twice, then hand off").
- `fallback` — go only when no other guard matched.
- `llm` — let the model decide, based on a condition you describe. This is the
  only guard that depends on the model.

Prefer the non-`llm` guards where you can; they are predictable.

### Terminals

A terminal ends the flow. Use `complete` when the task is done, or `handoff` to
escalate to a person.

## Validate and publish

- **Validate** checks the routine and reports problems in plain terms: a step that
  cannot be reached, a missing terminal, a slot referenced but not declared, an
  action the agent is not allowed to use. Fix these before publishing.
- **Publish** stores the routine as an immutable version and makes it live. The
  chat runtime loads and runs the published version.

Editing a published routine creates a new draft; publishing it creates a new
version. Conversations already running keep the version they started on.

## A worked example: contact a human

1. Trigger: "the user asks to be contacted by a person."
2. Slots: `email` (email, required), `message` (text, required).
3. Steps: a chat step "Ask for their email address" → a chat step "Ask for the
   message they want to send" → an action step that submits the contact request.
4. Transitions: `slot_filled` on `email`, then `slot_filled` on `message`, then
   `always` into the action.
5. Terminal: `complete`, "Confirm the request was sent."

This is the built-in contact flow, expressed as an authored routine.

## Current limits

- **Tool steps** (a step that runs a skill mid-flow) are not available yet, so a
  routine cannot, for example, call a lookup and branch on its result. This is a
  planned next step.
- A routine runs for the agent it is authored on. Export and import across agents
  is not available yet.
