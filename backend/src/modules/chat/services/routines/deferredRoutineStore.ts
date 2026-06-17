import type { ConversationRoutineStore, RoutineState } from "@radioso/conversation-contract";

export type CapturedRoutineTransition =
  | { kind: "save"; state: RoutineState }
  | { kind: "clear"; sessionId: string };

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

  constructor(private readonly inner: ConversationRoutineStore) {}

  loadActive(input: { sessionId: string }): ReturnType<ConversationRoutineStore["loadActive"]> {
    return this.inner.loadActive(input);
  }

  loadCompleted(input: { sessionId: string }): ReturnType<NonNullable<ConversationRoutineStore["loadCompleted"]>> {
    return this.inner.loadCompleted?.(input) ?? Promise.resolve([]);
  }

  async save(state: RoutineState): Promise<void> {
    this.transition = { kind: "save", state };
  }

  async clear(input: { sessionId: string }): Promise<void> {
    this.transition = { kind: "clear", sessionId: input.sessionId };
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
