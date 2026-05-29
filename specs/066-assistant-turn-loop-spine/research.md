# Research & Design Notes: Assistant Turn Loop As Skill-Dispatching Spine

This note records the design rationale behind `066` and the worked example that User Story 3 references. It argues the port shape on its own terms and shows the order-status-while-talking weave expressed against it without building an async engine.

## The problem the port shape solves

A conversational agent that owns a turn does two things a pure request→retrieve→answer pipeline cannot:

1. It **talks while it works** — a skill that takes time (an order lookup, a downstream API) should be able to say "let me check that" and stream progress, not block silently until it returns.
2. It **reconciles results that arrive later** — the agent may dispatch a skill, keep the conversation moving, and weave the result back in a subsequent turn.

Both are foreclosed the moment the skill-invocation port is typed `(input) => Promise<Answer>`. That signature can express neither interim emission nor a result that is not yet available. Adding either later is a breaking change to every executor. The cost of the wrong type is paid much later and is far higher than the cost of the right type now — so `066` fixes the type before lifting the spine, even though every skill resolves synchronously today.

## What the turn boundary should model

Model the turn-loop ↔ skill boundary as: **the agent dispatches an invocation and receives a result, possibly in a later turn** — an inbox/event shape, not pure call-return. Concretely the port must:

- **Hand the executor a narrow emit port** so it can append *structured* interim status/custom events to the live session while it works. The emit port is scoped to the current turn and does not expose the session store. It deliberately exposes no raw user-facing message channel: assistant copy is owned by the LLM/canned-rendering path in the turn loop, not authored in skill code (Radioso is multilingual). Executors signal progress structurally; the loop decides whether and how to render it to the user.
- **Return a disposition**, not a value: `settled` (the outcome is available now) or `deferred` (the outcome will arrive later as a session event). The conversation/session event stream is the system of record; a deferred result, if ever resolved, is a new event appended to that stream, never a mutation of the dispatching call's return.
- **Carry the outcome as a control envelope**, not a bare answer. A skill steers the rest of the turn and the session — it can hand back a grounded answer, structured outputs the model sees, model-invisible frontend metadata, control bits (flip the session to human-managed for handoff; mark the result valid for this response vs. the whole session), and transient single-turn guidance.

This shape reuses Radioso's existing declarative skill contract, which already anticipates asynchrony: `skillOutcomeStatus` includes `awaiting_tool`/`paused`/`awaiting_confirmation`, `interruptionPolicy` includes `pause_and_resume`, `executionClass` includes `deferred`, and the `execution` descriptor carries an `enqueue` flag. The contract was ready; only the executor *port* lagged.

## The port (as implemented in slice 1)

```ts
interface SkillEmitPort {            // structured only — no raw user-facing copy
  emitStatus(status: string, data?: Record<string, unknown>): Promise<void>;
  emitCustom(data: Record<string, unknown>): Promise<void>;
}

interface SkillInvocation {
  skill: SkillDefinition;
  collected: Record<string, unknown>;
  context?: Record<string, unknown>;
  emit: SkillEmitPort;        // append interim events to the current turn
  signal?: AbortSignal;       // cancel when the turn is abandoned
}

interface SkillOutcome {      // the control envelope
  status: SkillOutcomeStatus;
  answer?: string;
  outputs?: Record<string, unknown>;
  control?: { sessionMode?: "automatic" | "manual"; lifespan?: "response" | "session" };
  guidance?: SkillTransientGuidance[];
  metadata?: Record<string, unknown>;   // frontend-only, not seen by the model
}

type SkillDispatchResult =
  | { disposition: "settled"; outcome: SkillOutcome }
  | { disposition: "deferred"; ticket: SkillDeferralTicket };  // resolution engine out of scope

interface SkillExecutorPort {
  dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult>;
}
```

There is no `(input) => Promise<Answer>` signature anywhere in the port (SC-005).

## Worked example: order-status-while-talking (FR-014)

A support agent is asked for an order's status. The lookup is slow, so the skill emits an interim status, then defers — its eventual result is modeled as a later session event. This compiles against the real port; no async engine runs.

```ts
const orderStatusSkill: SkillExecutorPort = {
  async dispatch(invocation): Promise<SkillDispatchResult> {
    // 1. Talk while we work: append an interim status to the live session.
    //    (Human-readable rendering of this status comes from the LLM/canned path,
    //     not from literal copy in orchestration code.)
    await invocation.emit.emitStatus("looking_up_order", {
      orderId: invocation.collected.orderId,
    });

    // 2. Hand the lookup to whatever resolves it out-of-band and return a ticket.
    //    No v1 executor actually does this — the engine that later appends the
    //    result as a session event is explicitly out of scope for 066.
    const ticketId = enqueueOrderLookup(invocation.collected.orderId); // illustrative
    return { disposition: "deferred", ticket: { ticketId } };
  },
};
```

The turn loop's contract for `deferred` (owned by slice 3, the loop) is: **complete the current turn without blocking on the deferred result.** When the result lands, it is appended to the session as a new event and reconciled on a later turn. None of that machinery is built here; the point is only that the port *permits* it without a type change.

A synchronous skill is the same port with the other arm:

```ts
const echoSkill: SkillExecutorPort = {
  async dispatch(invocation): Promise<SkillDispatchResult> {
    return {
      disposition: "settled",
      outcome: { status: "completed", answer: `Echo: ${invocation.collected.text}` },
    };
  },
};
```

Both the settled-envelope path and the deferred path are exercised as type-checked tests in `backend/tests/unit/skill-executor-registry.test.ts` (`skill-invocation port shape`).

## Decisions captured

- **Disposition over value.** `settled | deferred` rather than `Promise<Answer>`. This is the one shape that must not be foreclosed.
- **Emit port is narrow, per-turn, and structured-only.** Executors get `emitStatus/emitCustom`, not the session store and not a raw user-facing message channel. Assistant copy is owned by the loop's LLM/canned path, so skill code cannot bypass localization or prompt-owned wording. Call sites without a live session (today, the synchronous intake execution path) pass `noopSkillEmitPort`, preserving behavior.
- **Outcome is a steering envelope.** Reuses the existing `skillOutcomeStatus`; adds control bits (handoff, lifespan), transient guidance, and model-invisible metadata. The old flat `{ answer, outputs }` is removed.
- **No new persistence, no resolution engine.** The `deferred` ticket is intentionally minimal. Storing and reconciling deferred results is a later spec.

## What slice 1 changed (delivered)

The keystone port redefinition with a behavior-preserving shim:

- `backend/src/modules/skills/skillExecutorRegistry.ts` — replaced `SkillExecutorPort.execute(): Promise<SkillExecutorResult>` with `dispatch(): Promise<SkillDispatchResult>`; added `SkillInvocation`, `SkillEmitPort`, `SkillOutcome`, `SkillDispatchResult`, `SkillDeferralTicket`, and `noopSkillEmitPort`. Registry resolution logic is unchanged.
- `backend/src/modules/chat/services/configuredSkillIntakeProvider.ts` — the single runtime consumer now calls `dispatch` with `noopSkillEmitPort` and maps a `settled, completed` outcome to the intake path's `{ answer, outputs }`. It rejects both a `deferred` disposition and any non-`completed` settled status (`failed`, `awaiting_confirmation`, `awaiting_tool`, …) rather than silently reporting them as a completed/success skill — this synchronous path can only faithfully represent a terminal success; richer outcome handling is owned by the turn loop (slice 3). No v1 executor returns those.
- Public re-exports (`skills/public.ts`, `skills/composition.ts`) updated.
- Tests updated/added: `skill-executor-registry.test.ts` (incl. new envelope + deferred coverage), `configured-skill-intake-provider.test.ts`, `application-modules.test.ts`.

Behavior is unchanged: no concrete executors are registered yet (`skillExecutors: []`), so this is purely a substrate change. Slices 2–4 (retrieval-as-registered-skill, the loop + per-agent strategy, docs) depend on the `065` predecessor and remain to do.
