# Contract notes — Engine additions (conversation-contract + conversation-engine)

Design-time notes. **Runtime source of truth** = `packages/conversation-contract/index.d.ts` and the engine implementation. The engine learns only *"a step awaits external resolution of handle X with options of type T"* — never who decides, the transport, or the policy.

## `packages/conversation-contract/index.d.ts`

```typescript
// Suspend signal — a typed field on the resume result, NEVER a thrown sentinel
// (so the runner's transit-hop error handling cannot swallow it).
export interface RoutineAwaitingDecision {
  // NO `handle` here: the engine does not mint it. The HOST mints the opaque handle
  // when it persists the pending_decisions row, and passes it back on resume via
  // RoutineDecisionInput. The engine only declares "this step awaits a decision".
  stepId: string;            // the gate; resume MUST land here, re-running no prior step
  options: DecisionOption[]; // authored options the host presents/accepts
  captureKey: string;        // routine-variable key the chosen option is captured under
  reason?: string;           // why it gated (a reason, not a confidence number)
}
export interface DecisionOption { id: string; label: string; description?: string; payload?: unknown; }

// Added to ConversationRoutineResumeResult (mutually exclusive with terminal/yielded):
//   awaitingDecision?: RoutineAwaitingDecision;   // nextState.status === "suspended"

// Runtime step kind: RoutineStep.kind |= "await"; RoutineStep.decision?: { captureKey, options }
// (author vocab `approval` in backend routines/domain.ts compiles to runtime `await`)

// Read port for resume-by-handle, distinct from the active-routine store
// (ConversationRoutineStore.loadActive keeps returning only status==="active").
export interface SuspendedRoutineReader { loadSuspended(i: { handle: string }): Promise<RoutineState | null>; }

// The already-validated decision the host hands the engine (open? authorized? hash-matched? — all checked by the host).
export interface RoutineDecisionInput { handle: string; optionId: string; payload?: unknown; }
export interface ConversationRoutineDecisionResult extends ConversationRoutineResumeResult { resumed: boolean; }

// New engine method (sibling to attemptRoutine/resume): runs no selection/dispatch/compose itself.
// resumeAwaitingDecision(input): Promise<ConversationRoutineDecisionResult>

// MessageSource (orthogonal to chat `role`); full vocab carried, silent value reserved:
export type MessageSource =
  | "customer" | "ai_agent" | "human_agent"
  | "human_agent_on_behalf_of_ai_agent"   // reserved/unused in Tranche A
  | "system";
// + optional `source?: MessageSource` on ConversationMessage / ConversationEvent

// RoutineTraceStepEntry.event += "suspended" | "decision_notified" | "decision_applied"
```

## `packages/conversation-engine/src/awaitingDecision.ts` (NEW — mirrors `clarification.ts`)

Pure, stub-testable helper. Shape proven by the spike's inline mini-helper:

```typescript
export const resumeAwaitingDecision = async (input: {
  suspendedReader: SuspendedRoutineReader;
  routineRunner: ConversationRoutineRunner;
  turn: TurnContext;                 // host-reconstructed; carries NO synthetic user input event
  decision: RoutineDecisionInput;
  steeringResolver?: ConversationRoutineSteeringResolver;
}): Promise<ConversationRoutineDecisionResult>;
```

Internals: `loadSuspended(handle)` → `{resumed:false}` if missing/non-suspended → validate `optionId ∈ parked step.decision.options` (else `{resumed:false}`) → merge `{ [captureKey]: { id, payload } }` into `state.variables` → set `state.status="active"` → `routineRunner.resume({ turn, state })`. Because `state.path` ends at the gate and the gate's edges are deterministic `field`/`slot_filled` guards, `resume()` branches in code with **no selector call** (spike: `routineRunner.ts:398-402`), advances into the gated skill/action step (running it for the first time), and renders.

## `packages/conversation-engine/src/index.ts`

`DefaultConversationEngine.resumeAwaitingDecision` wraps the helper with the engine's wired ports. **Critical**: unlike `attemptRoutine`, it appends **no** synthetic user input event (red-team BLOCKER #3) and does not run the selector/slot-extraction path.

## `packages/conversation-engine/src/routineRunner.ts`

**Unchanged for resume** — the spike proves the existing `resume()` handles a decision-driven resume. The only addition is suspend-side detection of the `await` step kind (render the "awaiting review" reply via the existing renderer + emit the `awaitingDecision` result instead of advancing); the `await` step is never the resume *landing* — resume advances *off* it.

## Compiler invariants (enforced in `backend/src/modules/routines/`)

1. An `await` step's outgoing decision edges MUST be deterministic guards (`field`/`slot_filled`), never `llm` — else resume incurs a model round-trip and can yield/misroute.
2. An `await` step MUST NOT declare `metadata.collectsSlots` — else the extraction-only selector pass fires against a non-existent user message.
3. The gated side-effecting step MUST sit *after* the gate (`await → skill/action`), so resume reaches it post-approval for the first time.
4. Exactly one deterministic edge per decision outcome (approve / reject) + a fallback.
