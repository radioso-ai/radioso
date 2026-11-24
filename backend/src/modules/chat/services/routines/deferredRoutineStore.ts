import type { ConversationRoutineStore, Routine, RoutineState } from "@radioso/conversation-contract";

import type { RoutineSlotSave } from "../../../routines/public.js";
import { routineRunEventFields, type EndedRoutineRun } from "./routineRunEvents.js";

/**
 * `startedFrom` is the state the turn first read: the step it ran on, which can differ from the
 * one session preparation saw when another instance advanced the routine in between (#1543).
 * `asksConsent` says whether the saved routine asks consent (#1544), so a withdrawal can close
 * slots in the state; absent when the producer cannot tell, which persistence reads as asking.
 * `ending` is the ended run the workspace event log records (#1851), when the save ends one, and
 * `declaredSlotKeys` the routine's slots, which an action the run queued reaches the log with.
 * `slotSaves` are the slot values the ended run saves to attributes (#1884), in the turn's
 * transaction; they hold the run's own values, sensitive ones too, and go nowhere else.
 */
export type CapturedRoutineTransition =
  | {
    kind: "save";
    state: RoutineState;
    startedFrom?: RoutineState;
    asksConsent?: boolean;
    ending?: EndedRoutineRun;
    declaredSlotKeys?: string[];
    slotSaves?: RoutineSlotSave[];
  }
  | { kind: "clear"; sessionId: string; startedFrom?: RoutineState };

/**
 * A save's `asksConsent` for routine `routineId` among the turn's `routines`; none when the turn was
 * given no routines or this one is not among them, since only a known routine can say it asks none.
 */
export const asksConsentField = (routines: readonly Routine[] | undefined, routineId: string): { asksConsent?: boolean } => {
  const routine = routines?.find((candidate) => candidate.id === routineId);
  return routine ? { asksConsent: (routine.consents?.length ?? 0) > 0 } : {};
};

/**
 * The host-side embodiment of the command-capture model documented on
 * `ConversationStores`: the engine emits `save`/`clear` as effects, and this captures them.
 *
 * Wraps the durable routine-state store but *defers* the engine's save/clear: `loadActive`
 * still reads through, but `save`/`clear` only capture the intended transition instead of
 * writing it. The host flushes it with {@link commit} only after the turn's emitted actions
 * are durably enqueued — so if the enqueue fails or the process crashes first, the routine
 * is left untouched at its prior position and resumes (re-emitting the same idempotent
 * action) rather than advancing past a request that was never persisted. This is what keeps
 * the outbox recoverable without a cross-layer transaction.
 */
export class DeferredRoutineStore implements ConversationRoutineStore {
  private transition: CapturedRoutineTransition | null = null;
  private startedFrom: RoutineState | null | undefined;
  /** The ended runs the turn read, one of which a post-completion correction saves again. */
  private endedRuns: readonly RoutineState[] = [];

  constructor(
    private readonly inner: ConversationRoutineStore,
    private readonly startedMessageId?: string,
    /** The routines the turn runs, which tell persistence whether a saved routine asks consent. */
    private readonly routines?: readonly Routine[],
  ) {}

  async loadActive(input: { sessionId: string }): Promise<RoutineState | null> {
    const state = await this.inner.loadActive(input);
    if (this.startedFrom === undefined) {
      this.startedFrom = state;
    }
    return state;
  }

  private startedFromField(): { startedFrom?: RoutineState } {
    return this.startedFrom ? { startedFrom: this.startedFrom } : {};
  }

  async loadCompleted(input: { sessionId: string }): Promise<RoutineState[]> {
    const ended = await (this.inner.loadCompleted?.(input) ?? Promise.resolve([]));
    this.endedRuns = ended;
    return ended;
  }

  /** The run as it had ended, when `state` saves an ended run again; a correction re-saves only what it changed. */
  private endedBefore(state: RoutineState): RoutineState | undefined {
    return state.executionId === undefined
      ? undefined
      : this.endedRuns.find((ended) => ended.routineId === state.routineId && ended.executionId === state.executionId);
  }

  async save(state: RoutineState): Promise<void> {
    this.transition = {
      kind: "save",
      state: state.startedMessageId || !this.startedMessageId ? state : { ...state, startedMessageId: this.startedMessageId },
      ...this.startedFromField(),
      ...asksConsentField(this.routines, state.routineId),
      ...routineRunEventFields(this.routines, state, this.endedBefore(state)),
    };
  }

  async clear(input: { sessionId: string }): Promise<void> {
    this.transition = { kind: "clear", sessionId: input.sessionId, ...this.startedFromField() };
  }

  getTransition(): CapturedRoutineTransition | null {
    return this.transition;
  }

  consumeTransition(): CapturedRoutineTransition | null {
    const transition = this.transition;
    this.transition = null;
    return transition;
  }

  /** Flush the captured routine-state transition (if any) to the underlying store. */
  async commit(): Promise<void> {
    const transition = this.consumeTransition();
    if (!transition) {
      return;
    }
    if (transition.kind === "save") {
      await this.inner.save(transition.state);
    } else {
      await this.inner.clear({ sessionId: transition.sessionId });
    }
  }
}
