---
title: "Authoring Routines"
description: "Create and edit dashboard routines in the Document view, connect skills, test drafts, and manage their lifecycle."
last_updated: 2026-08-29
---

# Authoring Routines

A routine carries an agent through a multi-step task across turns. It can collect
information, call skills, take a branch, finish with a message, or hand the
conversation to a person.

Open an agent's **Routines** settings to manage its routines. The list has one
row for each routine lineage. Choose **New routine** for a draft, or select a
routine to open its editor.

The editor presents the draft as a **Document**: it reads as the flow the agent
follows, with the controls for each part alongside the words that describe it.
The engine compiles the draft into the graph it runs; authors work with the
routine rather than drawing that graph.

For the runtime model behind routines, see
[Conversational routines](./architecture/conversational-routines.md).

## Start a routine

Open **Routines** and choose **New routine**. At the top of the editor, set:

- **Name** — the name shown in settings.
- **Priority** — the tie-breaker when several routines match a turn.
- **Reentry** — how the routine behaves after it finishes in a conversation.
- **Activation trigger** — a plain-language account of when the routine starts.

Write the trigger as an operator would describe the task. Radioso judges its
meaning, so “customer reports coffee that arrived damaged, stale, or wrong”
gives the agent useful context.

### Reentry

A routine can finish more than once in a conversation. Reentry decides what a
later matching message does:

- **Once per conversation** — the default. Use this for one-time tasks such as
  capturing a lead.
- **Every time it matches** — use this for repeatable tasks such as looking up
  an order.
- **Let the assistant decide** — the agent chooses whether to resume the run,
  start a fresh one, or leave the completed run in place.

## Document view

**Document** lays a routine out from top to bottom: a **Starts when** line,
**Information**, numbered steps, branch rows, and endings. A skill step includes
a **uses → sets** line so its input bindings and assigned outputs remain visible
in the flow.

Edit the **Starts when** line directly. Add information, steps, branches, and
endings where they belong in the flow. That proximity makes the decision behind
each transition easy to review with the instructions it follows.

A published or archived version opens here too, as a read-only document. That
rest state is the version a colleague reads to learn what the agent does.

Open a step by its number to change what it does — **Ask or tell**, **Call a
skill**, **Dispatch an action**, or **Approval**. The instruction you wrote stays
with the step, and an approval gets its Approve and Decline choices seeded. Press
Enter inside an instruction to break it across lines when a step needs a couple
of sentences on their own lines; the breaks are part of what the agent reads.

### Capture information

Write a step instruction in plain language and type `@` when the agent needs a
value, such as `@order_number` or `@email`. The value appears in
**Information**, where you choose its type: `text`, `number`, `boolean`,
`email`, or `date`.

When a step asks for a value, the routine waits for the visitor's reply, stores
it under that name, then continues. A type controls the comparisons available
on a later branch. In **Information**, you can also mark a value:

- **Optional** when the flow may reach an ending while the value remains empty.
- **Editable after completion** when a visitor may correct it after the routine
  finishes, such as an email address or a date.

An `@` reference uses the same stored value throughout the routine. A skill
output can also supply a value that later steps and branches read.

### Add steps and connect skills

Use the **+ Step** menu to add a **chat**, **skill**, **approval**, or **action**
step. Chat steps guide the conversation. Skill steps call a capability available
to the agent, such as `retrieve`, `email`, `webhook_call`, or `mcp_tool`. Action
steps emit an outbox action, such as `contact.send`, then continue through the
flow.

Select a skill step to configure its **uses → sets** bindings. Each required
input receives either a fixed value or an `@` value already held by the routine.
Assign a skill output to an `@` value when another step or branch needs it.
For example, a refund step can use `@order_id`, set `channel` to `support`, and
store the result as `@refund_id` for its final message.

A skill name with no matching capability on the agent appears as **unknown
skill**. Choose the intended skill, then validate the draft.

### Shape branches with condition rows

Add a condition row beneath a step to decide where the routine goes next. Each
row names its target: another step, a **Finish** ending, or a **Hand off** ending.
Rows run in order, so place the general path after the more specific paths.

Choose the decision mode on the row:

- **Rule** makes an exact, typed check, such as `amount is greater than 100`,
  `email is present`, a skill outcome of `failed`, or a bounded retry count.
- **AI decides** gives the agent a condition to judge in context, such as
  “the customer seems unsure.”

Use **Rule** for stable facts like amounts, dates, present values, skill
outcomes, and retry limits. Use **AI decides** when the choice depends on the
meaning of the conversation. A backward target includes **Max N** so the loop
has a bounded number of passes.

A skill step can also branch on an outcome status, such as `succeeded` or
`failed`. The outcome row belongs under the skill that produces that status.
For a collection checkpoint, add a slot-filled rule that waits for the selected
`@` values before taking its target.

### Add approval decisions

Use an approval step before a consequential action, such as issuing a refund or
sending a webhook. The step pauses the routine and presents a workspace member
with a set of choices in the **Inbox**. Their selection sends the routine
along that choice's decision edge.

Add an approval step from **+ Step**, give the decision a clear name, and add two
to eight choices. Every choice has a label and a target: another step, **Finish**,
or **Hand off**. The initial **Approve** and **Decline** choices suit many flows;
you can add choices such as **Ask for receipt** to collect information before the
decision returns to the gate.

The agent replies with the approval-step message while the decision awaits a
workspace member. When someone chooses an option, the routine resumes at the
choice target and keeps its collected information.

### Finish or hand off

An ending row completes the routine with **Finish** or sends it to a person with
**Hand off**. Set the message the agent delivers for each ending. Use named
endings when different paths require distinct completion messages, such as an
eligible refund and an ineligible refund.

The routine's **Completion message** controls its default finish. Its **Handoff
message** controls the standard escalation reply. A named ending carries its own
message and appears as a target in the branch rows that reach it.

### Read validation notes

The editor validates while you work. A note appears next to the row or field that
needs attention, keeping the issue beside the part of the flow you edit. Common
notes identify a missing branch target, a step that has no path to an ending, an
unset required skill input, a value whose type conflicts with a comparison, or a
missing webhook destination for completion export.

Choose **Save draft** to keep work in progress. **Publish** creates the immutable
version that the chat runtime runs after the draft validates cleanly.

## Test a draft before publishing

On a saved draft, choose **Test draft** to open a live test chat over the editor.
The draft can activate and run turn by turn in that conversation, then returns to
normal answering when it finishes.

- **Test draft** uses the latest saved draft; save after a change before testing.
- The test conversation stays separate from your other test chats.
- The selected draft joins the agent's published routines for that test chat.

Use the test to check the trigger, information collection, skill bindings,
branches, endings, and handoffs before publishing.

## Completion export

The **Completion export** panel lets a routine send its collected values to a
workspace webhook destination when it reaches selected terminal kinds. Enable
the export, choose the destination, then select `complete`, `handoff`, or both.

The routine uses a `webhook_call` skill, commonly named `completion_export`, to
reach the destination. The stored configuration identifies the destination by
its stable id, so a destination name can change while routines continue to point
at the same destination.

```json
{
  "completionExport": {
    "enabled": true,
    "triggerKinds": ["complete"],
    "destinationRef": "9ce5f2c1-8e47-47d3-b75d-8608e1a4be52"
  }
}
```

When the terminal matches `triggerKinds`, the runtime emits a `webhook.send`
action. The action worker resolves the destination, signs the JSON body with its
secret, and delivers it through the action outbox.

### Handoff notifications

When a routine reaches a `handoff` terminal, the chat turn sends the routine's
reply, requests human ownership of the conversation, and queues a
`handoff.notify` action. The notice gives operators the conversation, workspace,
agent, and routine context they need to open the conversation in the dashboard.

## Lifecycle and versions

Routine versions have four statuses:

- `draft` — editable work in progress.
- `published` — the active version for new conversations.
- `superseded` — a published version replaced by a later version.
- `archived` — a version kept outside the active set.

Published, superseded, and archived versions open as a read-only document. Choose
**Edit revision** on a published routine to create or open its draft revision.
Publishing that revision makes it the immutable active version while the prior
version becomes `superseded`.

Use **Archive** to take an active routine out of the starting set. **Restore**
returns an archived routine to the active set when its lineage has no published
version. A conversation already running a routine keeps its pinned version;
later conversations use the current published version.

The authoring API exposes the same lifecycle:

- `POST /api/v1/agents/{agentId}/routines/{routineId}/revise`
- `POST /api/v1/agents/{agentId}/routines/{routineId}/publish`
- `POST /api/v1/agents/{agentId}/routines/{routineId}/archive`
- `POST /api/v1/agents/{agentId}/routines/{routineId}/restore`
