# Research: Conversation Routines (Stateful Journeys)

**Feature**: 069-conversation-routines
**Inputs**: #482 (entanglement #4), #520 (intake unification → Routine runtime).

## Why this exists

Chat **intake** is a parallel mini-engine that runs *outside* the conversation engine. The EE
human-contact skill is the case in point: `humanContactIntakeProvider.ts` is a ~640-line stateful
state machine (collect email → collect message → submit) wired through `registerChatIntakeProvider`
and executed by `ChatService` *before* the engine turn (`chatService.ts:420-448`, `514-576`),
short-circuiting the engine entirely.

That hand-rolled state machine **is a journey**. Radioso's platform vocabulary already names the
abstraction: Directives steer (they don't execute); **Routines** are the stateful, multi-step flows.
The plan was always "Directives first, Routines second." This feature builds the Routine runtime and
transplants the contact flow onto it as the pilot — so the runtime is proven by a real journey rather
than designed against a hypothetical one.

## The Routine model

A Routine is an **acyclic directed graph** of steps and conditional transitions that guides a user
through a multi-turn flow:

- **Routine** — `triggers` (what activates it), a `root` entry step, and its steps/transitions.
- **Step** — an `action` instruction, an optional **skill** reference (a tool step), a kind
  (chat / skill / terminal), and metadata. The action is an *instruction that steers generation*, not
  hard-coded copy.
- **Transition** — `source` → `target` with an LLM-evaluated `condition` (e.g. "a valid email was
  provided").

The runtime is **stateless per turn but multi-turn aware**: it persists the session's position in the
routine (a node path) plus captured **variables**, and on each turn advances one step.

### How a turn runs a Routine

1. **Activation** — a routine activates when one of its **triggers** matches: an explicit intent
   signal (`inputMetadata.method === "intent_click"` for the routine's skill — the suggestion pill),
   or a matched intent/Directive condition (the natural-language case). A routine the session is
   already mid-way through stays active (resume).
2. **Resume-first** — if the session holds a non-terminal position for a routine, the engine resumes
   *that* routine before normal terminal-skill selection; it continues from the stored node, never
   re-evaluating from the root.
3. **Projection into steering** — the current step **projects into a Directive** that joins the
   existing steering set the composer reads. "Being at step X" steers the reply through the same
   mechanism authored Directives use — no parallel steering channel.
4. **Progression** — an LLM **next-step selector** reads the current step's outgoing transition
   conditions against the conversation and returns a structured decision: which condition is
   satisfied, whether the step completed, and any captured variable. A **skill (tool) step** with a
   single success edge advances deterministically after the skill returns.
5. **Persistence / resume** — the new position + variables are saved on the session; the next turn
   loads them and continues. Completion or expiry clears the state.

### Keystone insight: Routines project into Directives

A routine step does not need a new steering mechanism. Radioso's engine already **matches Directives
and merges them into the steering set** the composer applies (067/068). So the Routine runtime adds
only: (a) the graph model, (b) per-session position + variable state with resume, (c) the LLM
next-step selector (one prompt), (d) a projection of the current step into a Directive, and (e) skill
(tool) steps. Skills are Radioso's actions/tools; the contact "submit" is a skill step.

| Routine concept | What it is in Radioso | Exists today? |
|---|---|---|
| Routine (graph) | new contract type in `@radioso/conversation-contract` | new |
| Step (`action`, `skill`) | steering action projected to a Directive + optional skill dispatch | projection target + skill dispatch exist |
| Transition (`condition`) | LLM-evaluated edge | new (one selector prompt) |
| Activation triggers | explicit `intent_click` / matched Directive/intent | directive + intent matching exist |
| step → steering | step projected into a **Directive** | Directives + steering merge exist |
| skill (tool) step | dispatch via the existing skill-executor port | exists |
| routine position + variables | new session-scoped persisted state | new persistence |

## State ownership — refinement of the #520 decision

In the **minimal deferred substrate** framing (#520 comment), we agreed state/idempotency/TTL stay
**skill-owned**. The full Routine model **relocates** that:

- **Runtime-owned**: the routine *position* (node path) **and routine *variables*** (the collected
  slots — e.g. the email and message). These are journey state, not tool state.
- **Skill-owned**: only what a *tool* step genuinely owns — here the **submit's idempotency key** and
  the persisted contact-request row (the side effect). The collection state machine dissolves into
  routine steps + variables.
- **Routine-level**: expiry/TTL of an in-flight routine (the contact flow's 15-min window becomes a
  routine timeout).

So the contact flow's `skill_intake_states` (position + collected fields) is **superseded** by
runtime routine state; only the submit side-effect + its idempotency stays in the EE module.

## Contact flow as a Routine (worked example)

```
[root]
  -- (user expresses contact intent: intent_click OR NL) --> [ask_email]
[ask_email]   action: "Ask the user for their email address."
  -- (a valid email was provided) --> [ask_message]
  -- (user is asking about an embedded value, not answering) --> [paused → re-ask]
[ask_message]  action: "Ask the user for the message they want to send."
  -- (a message was provided) --> [submit]
[submit]  (skill step) skill: human_contact.request  (email + message routine variables)
  -- (submitted ok) --> [done]
  -- (submit failed) --> [failed]
[done]  action: "Confirm the request was sent."   [END]
```

- **Activation** = the existing triggers: explicit `inputMetadata.method === "intent_click"` for
  `human_contact` (the no-context-refusal suggestion **pill**), or the NL "do they want a human?"
  check (today `shouldStart`) expressed as a trigger condition.
- **email / message** are **routine variables** the next-step selector fills.
- **submit** is a **skill step** (existing `human_contact.request` executor); idempotency stays in
  the EE submit.
- The suggestion **pill** provider is unchanged — it only *proposes*; activation routes when the user
  acts.

## Decisions carried in

- **Routine-first, transplant contact last** (#520): build the runtime, migrate the contact flow once
  as the terminal phase; the bespoke intake stays until then.
- **Traces** (#520 decision #2): per-turn, runtime/step-sourced — not blocked on #517's trace-ownership
  cleanup. A single continuous routine trace is a later enhancement.
- **Implementation gated on the #516 engine soak.** Design (this spec) proceeds now.

## Anti-goals for v1

- No visual/authored routine builder UI; routines are code-defined/registered (like the skill catalog).
- No backtracking (rewinding to an earlier step on context change) — the contact pilot doesn't need it.
- No parallel/multi-routine-per-turn; one active routine per session for v1.
- No change to the headless `retrieval.*` / SDK / MCP surfaces.
