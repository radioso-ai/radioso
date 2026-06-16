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
- **Activation trigger** - a plain-language description of when the routine
  should start.

The trigger is judged by meaning, not by a keyword list. Write it the way an
operator would describe the task.

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
- **Skill** - a skill the routine calls, referenced by name. The skill is
  defined for the agent elsewhere; here you only name it. A step that contains a
  skill chip becomes a tool step the runtime resolves by name and dispatches
  through the shared skill-executor registry.
- **Handoff** - a branch target that ends the routine by escalating to a person.
- **End** - a branch target that completes the routine.
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

## Steps and branches

A line with no target chip is a step:

- A plain line is a chat step.
- A line that contains a skill chip is a tool step that calls that skill.

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

A **tool** step calls an external skill. Select the skill from the dropdown, which
lists the agent's defined external skills by name. The routine fills the skill's
exposed inputs at run time and branches on the result. See
[External Skills via MCP](./external-skills.md) for how to connect a server and
define skills.

A branch with a condition chip is decided by a reliable calculation. A branch
with only prose is decided by the model. The chip colour tells you which.

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
- a tool step that names no skill
- a comparison on a variable that does not exist, or a type that does not fit
  the check
- an enabled completion export that points at an unknown webhook destination

Use **Save draft** to keep work in progress. Use **Publish** to create an
immutable version that the chat runtime can run.

## Form view

**Form** is the strict, lower-level editor. Use it to inspect or adjust the
underlying draft fields, and to author shapes the prose editor cannot show.

The form exposes:

- slots, including whether each slot is **Required**
- step ids and step kind: `chat`, `tool`, or `action`
- transition guard kind: `llm`, `default`, `slot_filled`, `outcome`, or
  `counter`
- terminal kind and message: `complete` or `handoff`
- completion export settings for webhook delivery

A routine that uses any of these advanced shapes - an action (outbox) step, a
counter or outcome branch, a custom terminal message, a non-required slot, or a
completion export - opens in **Form** automatically. The **Prose** tab shows a
short note pointing you to **Form** for that routine.

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
the destination name or URL. A destination can be renamed without breaking
routines that reference it.

When completion export is enabled, validation and publish check that the
destination exists in the same workspace. If it does not, the routine gets a
diagnostic on `completionExport.destinationRef`. Deleting a destination is also
blocked while a published routine references it.

When a routine reaches a terminal whose kind appears in `triggerKinds`, the
runtime emits a `webhook.send` action. The action worker resolves the
destination, signs the JSON body with the destination secret, and posts it over
the existing action outbox. Delivery uses the same public-host SSRF guard as
outbound contact webhooks.

Webhook export is gated per agent. If the agent does not have webhook exports
enabled, the worker records a terminal skip instead of retrying. Missing or
deleted destinations are also terminal skips; transient transport failures retry
through the action outbox.

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
