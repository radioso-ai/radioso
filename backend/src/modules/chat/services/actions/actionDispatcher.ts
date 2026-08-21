import type {
  ActionFailureOutcome,
  ActionRequestRecord,
} from "../../../../db/repositories/actionRequestRepository.js";

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
 */
export interface ActionHandler {
  handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void>;
  recordFailureOutcome?(input: {
    payload: Record<string, unknown>;
    context: ActionHandlerContext;
    outcome: Exclude<ActionFailureOutcome, "superseded">;
    error: string;
  }): Promise<void>;
}

/** The narrow slice of the outbox the dispatcher drains. */
export interface ActionOutboxConsumerPort {
  claimPending(limit: number, leaseSeconds: number): Promise<ActionRequestRecord[]>;
  // The dispatcher ignores the result; the repository reports whether the row
  // transitioned so the push decorator can publish only real transitions.
  markDispatched(id: string, attempt: number): Promise<unknown>;
  recordFailure(
    id: string,
    error: string,
    attempt: number,
    maxAttempts: number,
    retryBackoffSeconds: number,
  ): Promise<ActionFailureOutcome>;
}

export interface ActionDispatchOptions {
  /** A claimed row is reclaimable after this long without progress (crashed worker). */
  leaseSeconds: number;
  /** Total dispatch attempts before a failing request becomes terminal `failed`. */
  maxAttempts: number;
  /** Backoff before a failed-but-retryable request is eligible again. */
  retryBackoffSeconds: number;
}

const DEFAULT_DISPATCH_OPTIONS: ActionDispatchOptions = {
  leaseSeconds: 300,
  maxAttempts: 5,
  retryBackoffSeconds: 60,
};

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

/**
 * Drains the action outbox and routes each pending request by `type` to its registered
 * handler, marking the row dispatched on success or failed on error / no handler. A
 * worker calls {@link dispatchPending} on a poll loop; the conversation never waits on
 * this. An unregistered type is recorded `failed` (never silently dropped).
 */
export class ActionDispatcher {
  private readonly options: ActionDispatchOptions;

  constructor(
    private readonly outbox: ActionOutboxConsumerPort,
    private readonly registry: ActionHandlerRegistry,
    options: Partial<ActionDispatchOptions> = {},
  ) {
    this.options = { ...DEFAULT_DISPATCH_OPTIONS, ...options };
  }

  async dispatchPending(limit = 20): Promise<{ dispatched: number; retried: number; failed: number }> {
    const claimed = await this.outbox.claimPending(limit, this.options.leaseSeconds);
    let dispatched = 0;
    let retried = 0;
    let failed = 0;

    const onFailure = async (request: ActionRequestRecord, error: string): Promise<void> => {
      const outcome = await this.outbox.recordFailure(
        request.id,
        error,
        request.attempts,
        this.options.maxAttempts,
        this.options.retryBackoffSeconds,
      );
      if (outcome === "failed") {
        failed += 1;
      } else if (outcome === "retry") {
        retried += 1;
      }
      // `superseded` → another worker reclaimed this row; its result is authoritative.
    };

    for (const request of claimed) {
      const handler = this.registry.resolve(request.type);
      if (!handler) {
        await onFailure(request, `no_handler_for_type:${request.type}`);
        continue;
      }
      const context: ActionHandlerContext = {
        requestId: request.id,
        workspaceId: request.workspaceId,
        accountId: request.accountId,
        conversationId: request.conversationId,
        idempotencyKey: request.idempotencyKey,
        attempt: request.attempts,
        skillName: request.skillName,
      };
      try {
        await handler.handle({
          payload: request.payload,
          context,
        });
        await this.outbox.markDispatched(request.id, request.attempts);
        dispatched += 1;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const outcome = await this.outbox.recordFailure(
          request.id,
          errorMessage,
          request.attempts,
          this.options.maxAttempts,
          this.options.retryBackoffSeconds,
        );
        if (outcome === "failed") {
          failed += 1;
        } else if (outcome === "retry") {
          retried += 1;
        }
        if (outcome !== "superseded") {
          try {
            await handler.recordFailureOutcome?.({
              payload: request.payload,
              context,
              outcome,
              error: errorMessage,
            });
          } catch {
            // Delivery outcome recording is operational metadata; the outbox
            // failure classification above remains authoritative.
          }
        }
      }
    }

    return { dispatched, retried, failed };
  }
}
