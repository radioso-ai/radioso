import type { ConversationRoutineStore, RoutineState } from "@radioso/conversation-contract";

/**
 * `startedFrom` is the state the turn first read: the step it ran on, which can differ from the
 * one session preparation saw when another instance advanced the routine in between (#1543).
 */
export type CapturedRoutineTransition =
  | { kind: "save"; state: RoutineState; startedFrom?: RoutineState }
  | { kind: "clear"; sessionId: string; startedFrom?: RoutineState };

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

  constructor(private readonly inner: ConversationRoutineStore, private readonly startedMessageId?: string) {}

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

  loadCompleted(input: { sessionId: string }): ReturnType<NonNullable<ConversationRoutineStore["loadCompleted"]>> {
    return this.inner.loadCompleted?.(input) ?? Promise.resolve([]);
  }

  async save(state: RoutineState): Promise<void> {
    this.transition = {
      kind: "save",
      state: state.startedMessageId || !this.startedMessageId ? state : { ...state, startedMessageId: this.startedMessageId },
      ...this.startedFromField(),
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
