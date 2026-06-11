# Authoring Routines

A routine is a multi-step flow your agent runs across several turns: it collects
what a task needs, takes an action, and confirms. You build a routine as data, in
the agent's settings — no code or redeploy.

For the concepts behind routines, see
[Conversational routines](./architecture/conversational-routines.md). This page is
about building one.

## Where to author

Open an agent and go to **Routines** in the settings. The page lists the agent's
routines and lets you create a new one.

Each routine can be edited in two views:

- **Outline** is the default authoring view. It shows variables, ordered step
  cards, branch rows, and ends. Use this when writing or reviewing a routine.
- **Form** is the existing detailed view. It exposes the underlying draft fields
  for operators who need that level of control.

Both views edit the same routine draft. Switching between them does not create a
second copy of the routine. The same actions are available over the API under
`/api/v1/agents/<agentId>/routines`.

## Building a routine

A routine has a name, an activation trigger, and four parts you fill in.

### Activation

The **trigger** describes, in plain language, when the routine should start —
for example, "the user wants a person to follow up with them." The model judges
the trigger by meaning, so it works in any language. If two routines could start
on the same message, the one with the higher **priority** wins.

### Slots

Variables are the values the routine collects, such as an email or an order
number. Declare each variable once with a key, type (text, number, boolean,
email, or date), whether it is required, and a short description.

In the outline view, type `@`-style references or use the insert menu to place a
variable in a step instruction. The saved draft stores this as
`{{slot.<key>}}`. At run time it is replaced with the value collected so far.
Only reference a variable once it has been collected, such as in a confirmation.

### Steps

Steps are the units of the flow. In the outline view, each step has a label and
an instruction. The label is for the author; the stable step id is kept behind
the scenes so published versions and traces do not break when the label changes.

In the form view, two step kinds are available:

- A **chat** step asks the user for something or tells them something. Write the
  instruction in plain language; the assistant turns it into a reply.
- An **action** step fires a side effect — for example, submitting a contact
  request. Pick the action type. You can only use an action your agent is
  permitted to use; the page rejects one it is not.

If a user supplies several values in one message, the routine can advance through
several steps at once instead of asking for each in turn.

### Branches and transitions

A branch row connects one step to another step or end. Row order is precedence:
the first matching branch wins, and a row with no condition is the default path.
In the outline view, you do not choose guard kinds directly. The draft infers
them from the row:

- `default` — go when no condition, outcome, or counter is attached. If it is
  the only branch, it is the normal next step. If other branches exist, it is the
  last path.
- `slot_filled` — go once the named slots are present.
- `outcome` — branch on the result of the preceding action.
- `counter` — bound a retry or loop with a maximum attempt count. When the
  counter is exhausted, the default branch is used.
- `llm` — let the model decide, based on a condition you describe. This is the
  only guard that depends on the model.

Prefer structured rows where you can; they are predictable. Keep ordinary
in-step nuance in the instruction instead of making it a branch.

### Terminals

An end finishes the flow. In the outline view, turn on the **Handoff** chip when
the end should escalate to a person. Without that chip, the end is a normal
completion.

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
4. Branches: use default branches to move through the happy path, and add a
   handoff end if the flow needs escalation.
5. End: `complete`, "Confirm the request was sent."

This is the built-in contact flow, expressed as an authored routine.

## Current limits

- **Tool steps** (a step that runs a skill mid-flow) are not available yet, so a
  routine cannot, for example, call a lookup and branch on its result. This is a
  planned next step.
- A routine runs for the agent it is authored on. Export and import across agents
  is not available yet.
