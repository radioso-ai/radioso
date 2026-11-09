import type {
  ClarificationClearOutcome,
  ConversationClarificationStore,
  ConversationRoutineOfferMemory,
  PendingClarification,
  RecentClarificationReader,
} from "@radioso/conversation-contract";

/** The clarification persistence chat is given; the recent-row reader and offer memory are optional. */
export type ChatClarificationStore = ConversationClarificationStore
  & Partial<RecentClarificationReader>
  & Partial<ConversationRoutineOfferMemory>;

/**
 * A routine offer is saved as the turn's pending row, and the routines it offered are recorded with
 * it, so the two commit together or not at all.
 */
export type CapturedClarificationTransition =
  | { kind: "save"; pending: PendingClarification; offeredRoutineIds?: string[] }
  | { kind: "clear"; sessionId: string; outcome?: ClarificationClearOutcome };

/** The clarification state a turn reads and writes, held until the turn commits. */
export class DeferredClarificationStore implements ConversationClarificationStore, ConversationRoutineOfferMemory {
  private transition: CapturedClarificationTransition | null = null;
  private offeredRoutineIds: string[] = [];

  /**
   * Without an offer memory the store remembers only this turn's offers, which is all a replayed
   * turn has.
   */
  constructor(
    private readonly inner: ConversationClarificationStore,
    private readonly offerMemory?: ConversationRoutineOfferMemory,
  ) {}

  /** The offer memory a host's clarification store also keeps, if it keeps one. */
  static over(inner: ChatClarificationStore): DeferredClarificationStore {
    const keepsOffers = typeof inner.loadOffered === "function" && typeof inner.recordOffered === "function";
    return new DeferredClarificationStore(inner, keepsOffers ? inner as ConversationRoutineOfferMemory : undefined);
  }

  loadPending(input: { sessionId: string }): ReturnType<ConversationClarificationStore["loadPending"]> {
    return this.inner.loadPending(input);
  }

  async save(pending: PendingClarification): Promise<void> {
    this.transition = { kind: "save", pending };
  }

  async clear(input: { sessionId: string; outcome?: ClarificationClearOutcome }): Promise<void> {
    this.transition = { kind: "clear", sessionId: input.sessionId, outcome: input.outcome };
  }

  async loadOffered(input: { sessionId: string }): Promise<readonly string[]> {
    return [...((await this.offerMemory?.loadOffered(input)) ?? []), ...this.offeredRoutineIds];
  }

  async recordOffered(input: { sessionId: string; routineId: string }): Promise<void> {
    this.offeredRoutineIds.push(input.routineId);
  }

  getTransition(): CapturedClarificationTransition | null {
    if (this.transition?.kind === "save" && this.offeredRoutineIds.length > 0) {
      return { ...this.transition, offeredRoutineIds: [...this.offeredRoutineIds] };
    }
    return this.transition;
  }

  consumeTransition(): CapturedClarificationTransition | null {
    const transition = this.getTransition();
    this.transition = null;
    this.offeredRoutineIds = [];
    return transition;
  }

  async commit(): Promise<void> {
    const transition = this.consumeTransition();
    if (!transition) {
      return;
    }
    if (transition.kind === "clear") {
      await this.inner.clear({ sessionId: transition.sessionId, outcome: transition.outcome });
      return;
    }
    await this.inner.save(transition.pending);
    for (const routineId of transition.offeredRoutineIds ?? []) {
      await this.offerMemory?.recordOffered({ sessionId: transition.pending.sessionId, routineId });
    }
  }
}
