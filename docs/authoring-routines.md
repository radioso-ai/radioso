# Authoring Routines

A routine is a multi-step flow your agent runs across turns. It can collect
values, take an action, branch on what happened, and finish or hand off to a
person.

You manage routines in the agent's **Routines** settings. The settings section
shows one row per routine lineage, not one row per version. Choose **New
routine** or select an existing routine to open the editor screen.

The primary authoring view is **Outline**: an ordered set of variables, step
cards, branch rows, and ends. The graph the engine runs is compiled from that
draft. You do not draw or edit the graph directly.

For the runtime model behind routines, see
[Conversational routines](./architecture/conversational-routines.md).

## Start a routine

Open an agent, go to **Routines**, and choose **New routine**. Radioso opens a
separate editor screen for the draft. To edit an existing routine, select it
from the same list.

At the top of the editor, set:

- **Name** - the routine name shown in settings.
- **Priority** - the tie-breaker when more than one routine could start.
- **Activation trigger** - a plain-language description of when the routine
  should start.

The trigger is judged by meaning, not by a keyword list. Write it the way an
operator would describe the task.

## Draft from procedure

When you are creating a new routine in **Outline**, you can use **Draft from
procedure**.

1. Choose **Draft from procedure**.
2. Paste the SOP or operating procedure into **Procedure text**.
3. Choose **Load proposal**.
4. Review the proposed variables, steps, branches, and ends in the outline.
5. Edit anything that is wrong, then save or publish through the normal buttons.

The drafting assist creates an editable proposal. It does not save the routine,
publish it, or bypass validation. In this version it is only for initial drafting
of a new routine. It is not shown while editing an existing routine.

## Variables

Variables are the values the routine collects, such as `email`, `order_id`, or
`summary`.

In **Variables**, choose **Add variable** and fill in:

- the variable key
- the type: `text`, `number`, `boolean`, `email`, or `date`
- the description
- whether it is **Required**

Declare each variable once. In a step instruction, use **Insert variable** or type
an `@` mention, such as `@email`. The saved draft stores this as a structured
slot reference.

## Step cards

A step card is one beat in the routine. Each step has:

- **Step label** - the author-facing name for the step.
- **Instruction** - what the assistant should do at that point.
- **Branches** - optional rows that decide where the flow goes next.

Write instructions as if you were instructing a human agent. Keep normal guidance
inside the instruction. For example:

```text
Ask for @email. If it is about an order, also ask for @order_id.
```

That sentence is still one step. It does not create a branch because it does not
point to a different step or end.

Use **Insert variable** for variables and **Insert action** for actions. In the
current dashboard, the action picker exposes the registered `Contact Send`
action. When a step contains a known action mention, the stored step is inferred
as an action step. Otherwise it is a chat step.

The step label can change. The routine keeps a stable step id behind the scenes
so traces and published versions can still resolve the step.

## Branch rows

A branch row sends the routine from the current step to another step or end.

Each row has:

- **Condition** - optional prose for when this row should match.
- **Target** - the step or end to go to.
- **Max N** - an optional counter limit for retries or loops.
- **Outcome status** - shown only on steps that contain a known action.

Row order is precedence: the first matching branch wins. Put the default branch
last by leaving its condition, outcome status, and counter limit empty.

The outline view infers the stored guard from the row:

- A row with **Max N** becomes a `counter` branch.
- A row with **Outcome status** becomes an `outcome` branch.
- A row with **Condition** becomes an `llm` branch.
- A row with none of those fields becomes a `default` branch.

A `default` branch has two roles. If it is the only branch, it is the normal next
path. If it sits after conditioned branches, it is the last path when the others
do not match.

For a retry loop, put the counter on the row that loops back. When the counter is
exhausted, that row stops matching and the routine takes the default branch from
the same step. In practice, "try twice, then hand off" is a counter branch back
to the retry step plus a default branch to a handoff end.

## Branch or guidance

Use this rule when deciding whether to create a branch:

- If you want the routine to go somewhere else, add a branch row and choose a
  **Target**.
- If you only want to guide the assistant inside the current step, keep it as a
  sentence in **Instruction**.

In other words: want a branch, give it a target. Want guidance, keep it in the
step.

## Ends and handoff

An end finishes the routine. In **Ends**, choose **Add end** and fill in:

- **End label**
- **End message**
- **Handoff**

With **Handoff** off, the end is a normal completion. With **Handoff** on, the
routine ends by escalating to a person. Branch targets show handoff ends with the
word `handoff` in the target list.

### Completion export

A routine can declare a completion export:

```json
{
  "completionExport": {
    "enabled": true,
    "triggerKinds": ["complete"],
    "destinationRef": "9ce5f2c1-8e47-47d3-b75d-8608e1a4be52"
  }
}
```

`destinationRef` is the stable id of a workspace webhook destination. It is not
the destination name or URL. This means a destination can be renamed without
breaking routines that reference it.

When completion export is enabled, validation and publish check that the
destination exists in the same workspace. If it does not, the routine gets a
diagnostic on `completionExport.destinationRef`. Deleting a destination is also
blocked while a published routine references it.

When a routine reaches a terminal whose kind appears in `triggerKinds`, the
runtime emits a `webhook.send` action for this field. The action worker resolves
the destination, signs the JSON body with the destination secret, and posts it
over the existing action outbox. Delivery uses the same public-host SSRF guard as
outbound contact webhooks.

Webhook export is gated per agent. If the agent does not have webhook exports
enabled, the worker records a terminal skip instead of retrying. Missing or
deleted destinations are also terminal skips; transient transport failures retry
through the action outbox. The destination's `lastDeliveryStatus` and
`lastDeliveryAt` fields reflect the latest success, retry, failure, or skip.

## Validate and publish

Use **Validate** before publishing. Validation reports problems in author terms,
such as:

- a branch target that no longer exists
- a step that cannot reach an end
- a variable used in an instruction but not declared
- an action the agent is not allowed to use
- an enabled completion export that points at an unknown webhook destination
- a missing step, branch, or end field

Diagnostics appear near the relevant variable, step card, branch row, end, or
routine header when possible.

Use **Save draft** to keep work in progress. Use **Publish** to create an
immutable version that the chat runtime can run.

## Lifecycle and versions

A routine can have four statuses:

- `draft` - editable work in progress.
- `published` - the active version used for new conversations.
- `superseded` - an older published version replaced by a newer one.
- `archived` - a retired version that does not activate for new conversations.

Published, superseded, and archived versions are read-only. Choose **Edit
revision** on a published routine to create or open the lineage's draft revision.
Publishing that draft creates a new immutable version, marks the previous
published version as `superseded`, and removes the draft row.

The routine list shows the lineage once. It shows the current state, the active
version number, and a **draft revision** badge when a published routine has a
pending draft. Older versions are available in the editor's version history.

Use **Archive** to retire the active published version. Archived routines move to
the collapsed archived section and do not start in new conversations. Use
**Restore** to make an archived routine active again when no other version in the
lineage is published.

Conversations already running keep the version they started on. If a routine is
superseded or archived while a visitor is mid-flow, that visitor continues on the
pinned version; new conversations only consider the current `published` version.

The authoring API exposes the same lifecycle:

- `POST /api/v1/agents/{agentId}/routines/{routineId}/revise`
- `POST /api/v1/agents/{agentId}/routines/{routineId}/publish`
- `POST /api/v1/agents/{agentId}/routines/{routineId}/archive`
- `POST /api/v1/agents/{agentId}/routines/{routineId}/restore`

## Form view

**Form** remains available as a transitional alternate view while the outline
surface is completed and verified. It edits the same routine draft as **Outline**.
Switching views re-projects the same draft rather than creating a second copy.

The form exposes lower-level fields directly:

- slots instead of variables
- step ids and step kind: `chat`, `tool`, or `action`
- transition guard kind: `llm`, `default`, `slot_filled`, `outcome`, or `counter`
- terminal kind: `complete` or `handoff`
- completion export settings for webhook delivery

Use **Outline** for normal authoring. Use **Form** only when you need to inspect
or adjust the underlying draft fields while it remains available.
