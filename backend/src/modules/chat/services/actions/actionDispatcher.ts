import type { ActionFailureOutcome } from "../../../../db/repositories/actionRequestRepository.js";
import type { ActionDispatchOutcome } from "../../../../shared/domain/actionDispatchOutcome.js";

export { ActionDispatchSkippedError, type ActionDispatchOutcome } from "../../../../shared/domain/actionDispatchOutcome.js";

/** The context a handler receives alongside the action payload. */
export interface ActionHandlerContext {
  requestId: string;
  workspaceId: string | null;
  accountId: string | null;
  conversationId: string | null;
  idempotencyKey: string | null;
  attempt: number;
  /** The named skill that fired this action (see `EnqueueActionRequestInput.skillName`), or null. */
  skillName: string | null;
}

/**
 * Performs one action `type`. Registered at composition keyed by type. MUST be
 * idempotent — the same request may be redelivered (retries, at-least-once dispatch).
 *
 * Drained through the generic background-job runtime (#1509): `createActionDispatchJobHandler`
 * (`actionDispatchJob.ts`) resolves a handler by `type` and routes a claimed request to it,
 * calling `recordFailureOutcome` from the runtime's per-attempt hook (`outcome: "retry"`) and its
 * dead-letter hook (`outcome: "failed"`). Nothing here changed to make that move: an
 * `ActionHandler` implementation never needs to know what drives it.
 */
export interface ActionHandler {
  /**
   * Resolves once the action is delivered. Throws {@link ActionDispatchSkippedError} when nothing was
   * delivered by design, and anything else to be retried. A handler with several destinations
   * resolves with its {@link ActionDispatchOutcome} so a partial send is not recorded as a whole one.
   */
  handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<ActionDispatchOutcome | void>;
  recordFailureOutcome?(input: {
    payload: Record<string, unknown>;
    context: ActionHandlerContext;
    outcome: Exclude<ActionFailureOutcome, "superseded">;
    error: string;
  }): Promise<void>;
}

/** Resolves an {@link ActionHandler} by action `type`. */
export class ActionHandlerRegistry {
  private readonly handlers = new Map<string, ActionHandler>();

  constructor(registrations: { type: string; handler: ActionHandler }[] = []) {
    for (const { type, handler } of registrations) {
      this.register(type, handler);
    }
  }

  register(type: string, handler: ActionHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`Action handler for type "${type}" is already registered`);
    }
    this.handlers.set(type, handler);
  }

  resolve(type: string): ActionHandler | null {
    return this.handlers.get(type) ?? null;
  }

  get isEmpty(): boolean {
    return this.handlers.size === 0;
  }
}
