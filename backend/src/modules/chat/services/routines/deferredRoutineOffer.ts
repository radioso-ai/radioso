import type {
  ConversationClarificationStore,
  ConversationRoutineOfferMemory,
  PendingClarification,
  RoutineStartOffer,
} from "@radioso/conversation-contract";

import type { CapturedClarificationTransition } from "../clarification/deferredClarificationStore.js";

/** Where the routines a conversation was shown an offer for are remembered. */
export interface RoutineOfferStore extends ConversationRoutineOfferMemory {
  record(input: { sessionId: string; routineId: string }): Promise<void>;
}

/** An offer the visitor sees: the pending row the next turn maps a reply against, and its routine. */
export interface ShownRoutineOffer {
  pending: PendingClarification;
  routineId: string;
}

/** What the rest of the turn did, which decides whether its reply carries the offer. */
interface RoutineOfferTurnFacts {
  /** A routine took the turn over (the coverage pass substituted its reply). */
  routineRan: boolean;
  /** The turn's own clarification change; another surface's pending row takes the turn. */
  clarification?: CapturedClarificationTransition | null;
  /** The reply hands the conversation to a person, and such a reply leaves the closing out. */
  handsOff: boolean;
}

/**
 * The offer to start a routine a turn's answer may close with (#1716), held until the turn knows
 * whether the visitor sees it. It is shown only when the reply was composed with the closing
 * offer, no routine took the turn over, no other clarification took the turn's pending row, and
 * the reply keeps the conversation with the agent. Otherwise nothing is saved, so the next reply
 * is never mapped against an offer nobody read and the routine stays offerable.
 */
export class DeferredRoutineOffer implements ConversationRoutineOfferMemory {
  private offer?: RoutineStartOffer;
  private composed = false;

  /**
   * Without a store the turn remembers no earlier offer, which is all a replayed turn has. The
   * clarification store is the turn's own, used only where no turn transaction writes the offer.
   */
  constructor(
    private readonly store?: RoutineOfferStore,
    private readonly clarifications?: ConversationClarificationStore,
  ) {}

  async loadOffered(input: { sessionId: string }): Promise<readonly string[]> {
    return (await this.store?.loadOffered(input)) ?? [];
  }

  /** The routine pass offered this routine instead of starting it. */
  hold(offer: RoutineStartOffer): void {
    this.offer = offer;
    this.composed = false;
  }

  get held(): boolean {
    return this.offer !== undefined;
  }

  /** The offer a reply closes with. Asking for it means the reply is composed with the closing. */
  closing(): RoutineStartOffer | undefined {
    if (this.offer) {
      this.composed = true;
    }
    return this.offer;
  }

  shown(turn: RoutineOfferTurnFacts): ShownRoutineOffer | null {
    if (!this.offer || !this.composed || turn.routineRan || turn.handsOff || turn.clarification?.kind === "save") {
      return null;
    }
    return { pending: this.offer.pending, routineId: this.offer.routineId };
  }

  /**
   * Writes a shown offer where no turn transaction does (tests and hosts without one): the pending
   * row through the turn's clarification store, ahead of that store's own commit, then the memory.
   */
  async commit(shown: ShownRoutineOffer): Promise<void> {
    await this.clarifications?.save(shown.pending);
    await this.store?.record({ sessionId: shown.pending.sessionId, routineId: shown.routineId });
  }
}
