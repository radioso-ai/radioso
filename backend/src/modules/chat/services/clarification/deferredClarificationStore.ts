import type {
  ClarificationClearOutcome,
  ConversationClarificationStore,
  PendingClarification,
} from "@radioso/conversation-contract";

export type CapturedClarificationTransition =
  | { kind: "save"; pending: PendingClarification }
  | { kind: "clear"; sessionId: string; outcome?: ClarificationClearOutcome };

export class DeferredClarificationStore implements ConversationClarificationStore {
  private transition: CapturedClarificationTransition | null = null;

  constructor(private readonly inner: ConversationClarificationStore) {}

  loadPending(input: { sessionId: string }): ReturnType<ConversationClarificationStore["loadPending"]> {
    return this.inner.loadPending(input);
  }

  async save(pending: PendingClarification): Promise<void> {
    this.transition = { kind: "save", pending };
  }

  async clear(input: { sessionId: string; outcome?: ClarificationClearOutcome }): Promise<void> {
    this.transition = { kind: "clear", sessionId: input.sessionId, outcome: input.outcome };
  }

  getTransition(): CapturedClarificationTransition | null {
    return this.transition;
  }

  consumeTransition(): CapturedClarificationTransition | null {
    const transition = this.transition;
    this.transition = null;
    return transition;
  }

  async commit(): Promise<void> {
    const transition = this.consumeTransition();
    if (!transition) {
      return;
    }
    if (transition.kind === "save") {
      await this.inner.save(transition.pending);
    } else {
      await this.inner.clear({ sessionId: transition.sessionId, outcome: transition.outcome });
    }
  }
}
