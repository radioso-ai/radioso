---
title: "Authoring Routines"
description: "How to create and edit routines in the dashboard using the prose and form editors, bind skill inputs/outputs, copy a routine to text, and manage lifecycle."
last_updated: 2026-06-22
---

# Authoring Routines

A routine is a multi-step flow your agent runs across turns. It can collect
values, call a skill, branch on what happened, and finish or hand off to a
person.

You manage routines in the agent's **Routines** settings. The settings section
shows one row per routine lineage, not one row per version. Choose **New
routine** or select an existing routine to open the editor screen.

The editor has two views of the same routine draft:

- **Prose** - the primary view. You write the routine in plain language and
  insert inline chips for the parts that need structure.
- **Form** - a strict, lower-level view for routines the prose editor cannot
  show. Switching views re-projects the same draft; it does not create a copy.

The graph the engine runs is compiled from that draft. You do not draw or edit
the graph directly.

For the runtime model behind routines, see
[Conversational routines](./architecture/conversational-routines.md).

## Start a routine

Open an agent, go to **Routines**, and choose **New routine**. Radioso opens a
separate editor screen for the draft. To edit an existing routine, select it
from the same list. A routine that the prose editor cannot represent opens in
the **Form** view instead.

At the top of the editor, set:

- **Name** - the routine name shown in settings.
- **Priority** - the tie-breaker when more than one routine could start.
- **Reentry** - what happens after the routine finishes in a conversation.
- **Activation trigger** - a plain-language description of when the routine
  should start.

The trigger is judged by meaning, not by a keyword list. Write it the way an
operator would describe the task.

### Reentry

A routine can finish more than once in the same conversation. The reentry
setting decides whether a finished routine can start again. It does not change
the trigger; it only controls what happens after a run completes.

There are three options:

- **Once per conversation** - the default. After the routine completes, it does
  not start again in that conversation. Use this for tasks that should happen a
  single time, such as capturing a lead.
- **Every time it matches** - the routine can start again after it completes.
  Use this for repeatable tasks, such as looking up an order.
- **Let the assistant decide** - after the routine completes, the assistant reads
  the next message and chooses what to do: resume the same run keeping what it
  already collected, start a fresh run, or leave it finished. Use this for tasks
  that a visitor may continue or repeat in different ways.

The key point is that the default stays safe. An existing routine keeps running
once per conversation until you change this setting.

## Write the routine in prose

In the **Prose** view, write the routine the way you would explain it to a
teammate. Each line is one step. The default flow runs the steps in order and
finishes at the end.

To add structure, type `@` or use the toolbar to insert a chip. A chip is an
inline reference, not raw syntax. Each kind has its own colour:

- **Variable** (`@name`) - a value the routine collects, such as `@email` or
  `@order_id`. It compiles to a typed slot. The variable name is the slot key,
  so `@email` in a step is stored as a structured reference, not literal text.
  When a step asks for a variable, the routine waits on that step until the user
  provides it, then stores the answer under that name before moving on. You do
  not need a branch to make a collection step wait.
- **Skill** - a skill the routine calls. Type `@` and the menu lists the skills
  the agent actually has, so you pick one instead of guessing its name. The skill
  is still defined for the agent elsewhere; here you choose it and decide how its
  inputs are filled. A skill chip whose name the agent does not have is shown as
  **unknown skill**, so a typo or a forward reference is easy to spot. A step that
  contains a skill chip becomes a tool step the runtime dispatches through the
  shared skill port. Click the chip to see its inputs and outcomes and to bind
  them (see [Bind a skill's inputs and outputs](#bind-a-skills-inputs-and-outputs)).
- **Handoff** - a branch target that ends the routine by escalating to a person.
- **End** - a branch target that completes the routine.
- **Approval** - a gate that pauses for a human to choose one of several options,
  then continues down the matching branch. Insert it from the **Approval** toolbar
  button (see [Approval gates](#approval-gates)).
- **Condition** - a decided-in-code comparison on a variable. Build it from the
  **Condition** toolbar button (see below).
- **Step title** - names a step so a jump can target it. Use the **Step** toolbar
  button to turn the current line into a titled step; its title becomes a stable
  id, and the following lines are that step's instruction. Untitled lines are
  still steps - only a jump target needs a title.
- **Jump** - a branch target that sends the routine to another named step. Use the
  **Jump** toolbar button: choose the target step; to loop back to an earlier step,
  tick **Loop back** and set a max count. A backward jump must be bounded so the
  loop always ends (the count compiles to a `counter` guard).

The key point: chips for structure, prose for instruction. You never type curly
braces or arrows.

### Variable types

A variable has a type: `text`, `number`, `boolean`, `email`, or `date`. The type
is shown on the variable chip. Click the chip to change it, or set it inside the
**Condition** dialog when you build a comparison. The type decides which exact
comparisons are available.

A name identifies one thing. Once a name is used by a chip, the `@` menu will not
let a second chip of a different kind reuse it.

### Editable after completion

A variable can be marked **editable after** in the Form view. This controls one
thing: whether the visitor can correct that value after the routine has finished,
without running the whole routine again.

When a variable is editable and the visitor's next message changes it, the
assistant updates the stored value in place and confirms the change. The new value
must still match the variable's type — for example, a corrected email must be a
valid email. A variable that is not marked editable cannot be changed this way.

The default is off. Turn it on only for values a visitor may reasonably want to
fix, such as an email or a date.

## Steps and branches

A line with no target chip is a step:

- A plain line is a chat step.
- A line that contains a skill chip is a tool step that calls that skill.
- An approval step pauses the routine until an authorized workspace member
  resolves it. The routine stores a pending decision, replies that it is awaiting
  review, and does not run the gated step until the decision is approved.

A line that carries a **Handoff** or **End** chip is a branch from the current
step. The branch's guard - what decides whether it is taken - comes from the
line:

- If the line carries a **Condition** chip, the branch is **decided in code**: a
  typed comparison evaluated before the model is consulted.
- Otherwise the line's prose is the guard, **decided by the AI**.

In practice, "if the order is older than 6 months, hand off; otherwise continue"
is one step, one condition chip, and a handoff chip on the branch line.

### Decided in code vs decided by the AI

Use the **Condition** toolbar button to build a comparison:

1. Pick the variable.
2. Pick its type if it is not already set.
3. Pick the check. The checks depend on the type - for example `is`, `is one
   of`, and `is present` for text; `is greater than` for numbers; `is older
   than` and `is within the last` for dates.
4. Enter the value (and unit, for relative-date checks).

A **tool** step calls a skill. In the **Form** view, the skill field offers the
agent's skills and flags a name the agent does not have. The step branches on the
skill's outcome. Add or edit skills from the agent's **Skills** list. Each skill
is a named capability instance, such as `retrieve`, `email`, `slack_post`,
`webhook_call`, `mcp_tool`, or `notify`.

Every branch line shows how it is decided. A branch with a condition chip - or a
capped loop back to an earlier step - is marked **Rule**: an exact comparison
that behaves the same every time. A branch with only prose is marked **AI
decides**: the model reads the description and uses judgment, which is what you
want for fuzzy cases like "the customer seems unsure." The marker is derived from
the chips on the line, not from the words, so it reads the same in any language.

In practice: use a **Rule** for invariants - amounts, dates, whether a required
value is present. Use **AI decides** when the fork depends on meaning rather than
an exact value.

## Bind a skill's inputs and outputs

Open a skill chip, or the skill row in the **Form** view, to see what the skill
takes and returns. The panel lists the skill's **inputs** - each with a type and
whether it is required - and its **outcomes**, the results you can branch on.

For each input you choose where its value comes from:

- **A fixed value** - a literal you type, such as a channel name or a flag. It is
  the same on every run.
- **A variable** - a value the routine already holds: a slot it collected from the
  user, or an output an earlier skill step produced. You pick the variable by
  name.

The key point: the binding lives on the step, inside the routine. You no longer
match names by hand in the skill's own settings.

You can also assign a skill's **outputs** to variables. Give an output a variable
name, and later steps can read it - in a branch condition, or as the input to
another skill.

In practice, a refund step might bind its `order_id` input to the `@order_id`
slot you collected, set `channel` to a fixed value, and store the returned
`refund_id` in a variable that a later message reads back to the user.

A required input must resolve to a literal, or to a variable that is always set
before the step runs. If it cannot, validation reports it (see below).

## Branch rows

A branch row sends the routine from the current step to another step or end.

Each row has:

- **Condition** - optional prose for when this row should match.
- **Target** - the step or end to go to.
- **Max N** - an optional counter limit for retries or loops.
- **Outcome status** - shown only on steps that contain a known action.

Row order is precedence: the first matching branch wins. Put the default branch
last by leaving its condition, outcome status, and counter limit empty.

The Form view infers the stored guard from the row:

- A row with **Max N** becomes a `counter` branch.
- A row with **Outcome status** becomes an `outcome` branch.
- A row with **Condition** becomes an `llm` branch.
- A row with none of those fields becomes a `default` branch.

A `default` branch has two roles. If it is the only branch, it is the normal next
path. If it sits after conditioned branches, it is the last path when the others
do not match.

### Approval gates

Use an **approval gate** before a step with side effects, such as sending a
webhook or issuing a refund: it pauses the routine for a human to choose one of
several options, then continues down the branch for that choice. (An approval
gate is different from a handoff: a handoff *ends* the routine and transfers the
conversation to a person, while an approval gate *suspends* the routine, waits
for a decision, and resumes - the conversation stays AI-owned.)

An approval gate has two to eight **choices**. A gate must offer at least two,
because an approval is a real decision: the operator must be able to decline (or
take a different path, such as asking the customer for more detail), not only
rubber-stamp. New gates start seeded with **Approve** and **Decline**. Each
choice routes to its own step or terminal, and Radioso builds the deterministic
decision branch for it. The gate also has a **decision name** - a short id the
chosen choice is recorded under (default `decision`); you only need to change it
if a later step reads the result, for example branching on `refund_decision.id is
approve`. Every choice needs a target.

A choice can route anywhere a branch can. To let an operator ask for more
information rather than approve or decline, add a choice (for example "Ask for
receipt") that routes to a step which requests it and loops back to the gate.

Author an approval gate in either editor:

- **Prose** - click the **Approval** toolbar button. In the dialog, set each
  choice's label and where it continues (a titled step, **End**, or **Handoff**).
  The chip carries the whole gate, so the routing lives on the chip rather than
  on separate branch lines.
- **Form** - set a step's kind to **approval**. Add one row per choice, each with
  a label and a **continue to** target. The form synthesizes the decision guards
  from those targets.

When a conversation reaches the approval gate, the routine is suspended. The
assistant replies with the approval-step message, and Radioso creates a pending
decision that surfaces in the **Needs attention** inbox, where it shows one
button per choice. A dashboard operator picks one; the routine resumes down the
branch for that choice. If the chosen step has a side effect, that side effect is still
dispatched by the routine action outbox - the decision only records the choice
and resumes the routine.

A branch can jump to any step, not only the next one. A forward jump can skip
steps when a condition makes them unnecessary. A backward jump, including a jump
back to the same step, creates a loop and must use **Max N** so the runtime can
bound how many times that branch is taken.

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

A routine finishes in one of two ways:

- An **End** chip completes the routine.
- A **Handoff** chip ends the routine by escalating to a person.

The default flow ends at a normal completion, so a simple linear routine needs
no end chip. Use end and handoff chips on branch lines when a condition should
finish or escalate early.

The prose editor regenerates the completion and handoff messages from defaults.
If you need custom completion or handoff wording, edit the routine in the
**Form** view, which keeps that copy.

## Validate and publish

Use **Validate** before publishing. Validation reports problems in author terms,
such as:

- a branch target that no longer exists
- a step that cannot reach an end
- a variable used in an instruction but not declared
- a tool step that names no skill, or names a skill the agent does not have
- a required skill input that nothing fills
- a skill input bound to a value whose type does not fit, or to a variable the
  routine never sets
- a comparison on a variable that does not exist, or a type that does not fit
  the check
- a completion-export webhook skill that points at an unknown webhook destination

Use **Save draft** to keep work in progress. Use **Publish** to create an
immutable version that the chat runtime can run.

## Copy a routine to text

You can copy a routine out of the **Prose** view and paste it back later without
losing its chips. Select the whole routine (Select All) and copy; Radioso puts
the whole routine on the clipboard as plain text, including the name and trigger.
Paste it into a note, a document, or a message — anywhere you keep text.
(Copying only part of the prose copies that selection as ordinary text, the way
any editor does.)

In practice the text is the routine written with simple markers instead of
chips:

- a variable or skill is `@name`
- a step title is a line starting with `# `
- an end is `-> end`, a handoff is `-> handoff`, and a jump is `-> step:<id>`
- a decided-in-code check is `[if amount >= 100]`

To restore the routine, paste the text back into the prose editor. The markers
become chips again, and the name and trigger fill in from the text.

The text carries names, not internal ids. Pasting into the same agent resolves
every skill cleanly. Pasting into a different agent that does not have a referenced
skill leaves that step's skill marked **unknown skill**, the same as typing a
skill the agent lacks — point it at a skill the agent has, then validate.

## Form view

**Form** is the strict, lower-level editor. Use it to inspect or adjust the
underlying draft fields, and to author shapes the prose editor cannot show.

The form exposes:

- slots, including whether each slot is **Required**
- step ids and step kind: `chat`, `tool`, `action`, or `approval`
- for an `approval` step, its choices (each with a branch target) and decision name
- transition guard kind: `llm`, `default`, `slot_filled`, `outcome`, or
  `counter`
- terminal kind and message: `complete` or `handoff`
- completion export through a `webhook_call` skill

A routine that uses any of these advanced shapes - an action (outbox) step, a
counter or outcome branch, a custom terminal message, a non-required slot, or a
completion export - opens in **Form** automatically. The **Prose** tab shows a
short note pointing you to **Form** for that routine.

### Completion export

Completion export is configured as an agent skill. Create or edit a
`webhook_call` skill, commonly named `completion_export`, and bind it to a
workspace webhook destination. The routine runtime invokes that skill when a
published routine reaches completion.

The stored routine shape still contains completion export metadata:

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
the destination name or URL. A destination can be renamed without breaking
routines that reference it.

When completion export is enabled through the skill, validation and publish check
that the destination exists in the same workspace. If it does not, the routine
gets a diagnostic on `completionExport.destinationRef`. Deleting a destination is
also blocked while a published routine references it.

When a routine reaches a terminal whose kind appears in `triggerKinds`, the
runtime emits a `webhook.send` action. The action worker resolves the
destination, signs the JSON body with the destination secret, and posts it over
the existing action outbox. Delivery uses the same public-host SSRF guard as
outbound contact webhooks.

Webhook export is gated by the `completion_export` skill. If that skill is
disabled, the worker records a terminal skip instead of retrying. Missing or
deleted destinations are also terminal skips; transient transport failures retry
through the action outbox.

### Handoff notifications

When a routine reaches a `handoff` terminal, the chat turn still renders the
routine-authored reply. In the same turn commit, Radioso requests human ownership
for the conversation and enqueues a `handoff.notify` action.

The action payload contains conversation, workspace, agent, and triggering user
message ids, the handoff reason, the routine and step ids, and a dashboard path
for opening the conversation. It does not include prompts, completions,
retrieved content, slot values, credentials, or connection strings.

`handoff.notify` uses the same contact-delivery configuration as `contact.send`.
The action worker resolves the configured recipients or workspace owner fallback
and sends a neutral notice that a conversation needs a human operator. It uses
the existing routine action outbox, so lease, retry, idempotency, and failure
semantics are unchanged.

## Lifecycle and versions

A routine can have four statuses:

- `draft` - editable work in progress.
- `published` - the active version used for new conversations.
- `superseded` - an older published version replaced by a newer one.
- `archived` - a retired version that does not activate for new conversations.

Published, superseded, and archived versions are read-only and open in the
**Form** view. Choose **Edit revision** on a published routine to create or open
the lineage's draft revision. Publishing that draft makes the draft row the new
immutable published version in place, keeping its id and assigned version. The
previous published version is marked `superseded`.

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
