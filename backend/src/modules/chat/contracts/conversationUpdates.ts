/**
 * One message as a calling agent reads it when it comes back to a conversation it
 * cannot sit in. `author` is provenance, not role: an operator's reply is stored with
 * `role = 'assistant'`, so role alone would report a person as the agent.
 */
export interface ConversationUpdateMessage {
  id: string;
  author: "agent" | "human";
  createdAt: string;
  text: string;
}

/**
 * Who owns the conversation right now. A read reports only the state: `suppressed` is
 * a fact about a turn — whether the agent generated anything on it — and a read runs
 * no turn, so it has nothing to report there.
 */
export interface ConversationOwnershipState {
  state: "ai_owned" | "human_owned";
}

/**
 * A page of updates plus the cursor to resume from. The cursor is opaque: history
 * keysets on `(created_at, id)`, which a bare message id cannot seek against.
 */
export interface ConversationUpdatePage {
  messages: ConversationUpdateMessage[];
  cursor: string | null;
  ownership: ConversationOwnershipState;
}

/**
 * The narrow slice of conversation history the update reader needs, declared here
 * rather than imported, so app composition can wire the reader without reaching into
 * the history service. `ChatHistoryService` satisfies it structurally.
 */
export interface ConversationTailReaderPort {
  tailConversation(
    workspaceId: string,
    conversationId: string,
    input: { cursor?: string; limit: number },
    options?: { includeOwnership?: boolean; includeLatency?: boolean },
  ): Promise<{
    messages: readonly { id: string; source: string; content: string; createdAt: string }[];
    cursor: string | null;
    ownership?: ConversationOwnershipState;
  }>;
}

export interface ConversationUpdateReader {
  read(input: {
    workspaceId: string;
    conversationId: string;
    cursor?: string;
    limit: number;
  }): Promise<ConversationUpdatePage>;
}

/**
 * `woken` means something happened that is worth re-querying for — a bus event or a
 * poll tick; `deadline` means the wait is over and the caller must answer.
 */
export type ConversationUpdateWaitOutcome = "woken" | "deadline";

/**
 * Waits for a reason to re-read a conversation. Deliberately not a subscription: the
 * conversation event bus is per-process, so on a multi-instance deployment an operator
 * reply handled elsewhere would never reach a parked listener. Implementations race the
 * bus against a bounded re-poll and the deadline, and hold no database connection while
 * they wait.
 */
export interface ConversationUpdateWaiter {
  wait(input: {
    conversationId: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<ConversationUpdateWaitOutcome>;
}
