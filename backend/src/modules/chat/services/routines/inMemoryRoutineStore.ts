import type { ConversationRoutineStore, RoutineState } from "@radioso/conversation-contract";

/**
 * A non-persistent {@link ConversationRoutineStore} for a single ephemeral session,
 * used by eval workbench replay. A replayed turn has no durable conversation, so the
 * routine engine's one state read (`loadActive`) must be served from memory.
 *
 * Seed it with a starting {@link RoutineState} to resume mid-routine: the engine reads
 * the full state — `path` (step/back-edge history) and `attempts` (counter guards) —
 * so a faithful seed reproduces the exact routine position, not an approximation. Leave
 * the seed empty to test activation-on-this-turn.
 *
 * Writes the engine makes during the replayed turn are kept in memory (so a single turn
 * advances correctly) and are simply discarded when the runner is done — replay never
 * mutates the live `routine_states` table.
 */
export class InMemoryRoutineStore implements ConversationRoutineStore {
  private readonly states = new Map<string, RoutineState>();

  constructor(seed?: RoutineState | null) {
    if (seed) {
      this.states.set(seed.sessionId, seed);
    }
  }

  async loadActive({ sessionId }: { sessionId: string }): Promise<RoutineState | null> {
    const state = this.states.get(sessionId);
    return state && state.status === "active" ? state : null;
  }

  async loadCompleted({ sessionId }: { sessionId: string }): Promise<RoutineState[]> {
    const state = this.states.get(sessionId);
    return state && state.status === "completed" ? [state] : [];
  }

  async save(state: RoutineState): Promise<void> {
    this.states.set(state.sessionId, state);
  }

  async clear({ sessionId }: { sessionId: string }): Promise<void> {
    this.states.delete(sessionId);
  }
}
