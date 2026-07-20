import type { DirectiveFiringState } from "./directiveLifecycle.js";

/**
 * Per-conversation directive firing memory. The host loads a conversation's
 * firing state before matching (to suppress once/cooldown re-fires) and saves the
 * advanced state at turn completion. Keyed by the engine session id (the
 * conversation id). A missing row means the conversation has no firing memory yet.
 */
export interface DirectiveStateStore {
  load(input: { sessionId: string }): Promise<DirectiveFiringState | null>;
  save(input: { sessionId: string; state: DirectiveFiringState }): Promise<void>;
}

export const noopDirectiveStateStore: DirectiveStateStore = {
  async load(): Promise<DirectiveFiringState | null> {
    return null;
  },
  async save(): Promise<void> {
    // no-op
  },
};
