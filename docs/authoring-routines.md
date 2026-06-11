# Authoring Routines

A routine is a multi-step flow your agent runs across turns. It can collect
values, take an action, branch on what happened, and finish or hand off to a
person.

You author a routine in the agent's **Routines** settings. The primary authoring
view is **Outline**: an ordered set of variables, step cards, branch rows, and
ends. The graph the engine runs is compiled from that draft. You do not draw or
edit the graph directly.

For the runtime model behind routines, see
[Conversational routines](./architecture/conversational-routines.md).

## Start a routine

Open an agent, go to **Routines**, and choose **New routine**.

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

## Validate and publish

Use **Validate** before publishing. Validation reports problems in author terms,
such as:

- a branch target that no longer exists
- a step that cannot reach an end
- a variable used in an instruction but not declared
- an action the agent is not allowed to use
- a missing step, branch, or end field

Diagnostics appear near the relevant variable, step card, branch row, end, or
routine header when possible.

Use **Save draft** to keep work in progress. Use **Publish** to create an
immutable version that the chat runtime can run. Editing a published routine
creates a new draft; publishing that draft creates a new version. Conversations
already running keep the version they started on.

## Form view

**Form** remains available as a transitional alternate view while the outline
surface is completed and verified. It edits the same routine draft as **Outline**.
Switching views re-projects the same draft rather than creating a second copy.

The form exposes lower-level fields directly:

- slots instead of variables
- step ids and step kind: `chat`, `tool`, or `action`
- transition guard kind: `llm`, `default`, `slot_filled`, `outcome`, or `counter`
- terminal kind: `complete` or `handoff`

Use **Outline** for normal authoring. Use **Form** only when you need to inspect
or adjust the underlying draft fields while it remains available.
