import type {
  ConversationEvent,
  ConversationMessage,
  ConversationRoutineStore,
  ConversationStores,
  RoutineState,
} from "@radioso/conversation-contract";

const cloneRecord = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneRecord(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneRecord(entry)]),
    ) as T;
  }
  return value;
};

const eventToMessage = (event: ConversationEvent): ConversationMessage | null => {
  if (!event.role || event.content === undefined) {
    return null;
  }
  return {
    id: event.id,
    role: event.role,
    content: event.content,
    createdAt: event.createdAt,
    metadata: event.metadata ? cloneRecord(event.metadata) : undefined,
  };
};

export class InMemoryConversationStores implements ConversationStores {
  private readonly eventsBySession = new Map<string, ConversationEvent[]>();

  async loadHistory(input: { sessionId: string; limit?: number }): Promise<ConversationMessage[]> {
    const events = this.eventsBySession.get(input.sessionId) ?? [];
    const messages = events.flatMap((event) => {
      const message = eventToMessage(event);
      return message ? [message] : [];
    });
    return cloneRecord(input.limit ? messages.slice(-input.limit) : messages);
  }

  async appendEvent(event: ConversationEvent): Promise<void> {
    const events = this.eventsBySession.get(event.sessionId) ?? [];
    events.push(cloneRecord(event));
    this.eventsBySession.set(event.sessionId, events);
  }

  listEvents(sessionId: string): ConversationEvent[] {
    return cloneRecord(this.eventsBySession.get(sessionId) ?? []);
  }
}

export interface InMemoryConversationRoutineStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

interface StoredRoutineState {
  state: RoutineState;
  savedAtMs: number;
}

export class InMemoryConversationRoutineStore implements ConversationRoutineStore {
  private readonly states = new Map<string, StoredRoutineState>();
  private readonly ttlMs?: number;
  private readonly now: () => number;

  constructor(options: InMemoryConversationRoutineStoreOptions = {}) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  async loadActive(input: { sessionId: string }): Promise<RoutineState | null> {
    const stored = this.states.get(input.sessionId);
    if (!stored) {
      return null;
    }
    if (stored.state.status !== "active") {
      return null;
    }
    if (this.isExpired(stored)) {
      this.states.delete(input.sessionId);
      return null;
    }
    return cloneRecord(stored.state);
  }

  async loadCompleted(input: { sessionId: string }): Promise<RoutineState[]> {
    const stored = this.states.get(input.sessionId);
    if (!stored) {
      return [];
    }
    if (this.isExpired(stored)) {
      this.states.delete(input.sessionId);
      return [];
    }
    return stored.state.status === "completed" ? [cloneRecord(stored.state)] : [];
  }

  async save(state: RoutineState): Promise<void> {
    this.states.set(state.sessionId, {
      state: cloneRecord(state),
      savedAtMs: this.now(),
    });
  }

  async clear(input: { sessionId: string }): Promise<void> {
    this.states.delete(input.sessionId);
  }

  private isExpired(stored: StoredRoutineState): boolean {
    return this.ttlMs !== undefined && this.now() - stored.savedAtMs >= this.ttlMs;
  }
}
