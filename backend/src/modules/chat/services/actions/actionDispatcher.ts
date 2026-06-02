import type { ActionRequestRecord } from "../../../../db/repositories/actionRequestRepository.js";

/** The context a handler receives alongside the action payload. */
export interface ActionHandlerContext {
  workspaceId: string | null;
  accountId: string | null;
  conversationId: string | null;
}

/**
 * Performs one action `type`. Registered at composition keyed by type. MUST be
 * idempotent — the same request may be redelivered (retries, at-least-once dispatch).
 */
export interface ActionHandler {
  handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void>;
}

/** The narrow slice of the outbox the dispatcher drains. */
export interface ActionOutboxConsumerPort {
  claimPending(limit: number): Promise<ActionRequestRecord[]>;
  markDispatched(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
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

/**
 * Drains the action outbox and routes each pending request by `type` to its registered
 * handler, marking the row dispatched on success or failed on error / no handler. A
 * worker calls {@link dispatchPending} on a poll loop; the conversation never waits on
 * this. An unregistered type is recorded `failed` (never silently dropped).
 */
export class ActionDispatcher {
  constructor(
    private readonly outbox: ActionOutboxConsumerPort,
    private readonly registry: ActionHandlerRegistry,
  ) {}

  async dispatchPending(limit = 20): Promise<{ dispatched: number; failed: number }> {
    const pending = await this.outbox.claimPending(limit);
    let dispatched = 0;
    let failed = 0;

    for (const request of pending) {
      const handler = this.registry.resolve(request.type);
      if (!handler) {
        await this.outbox.markFailed(request.id, `no_handler_for_type:${request.type}`);
        failed += 1;
        continue;
      }
      try {
        await handler.handle({
          payload: request.payload,
          context: {
            workspaceId: request.workspaceId,
            accountId: request.accountId,
            conversationId: request.conversationId,
          },
        });
        await this.outbox.markDispatched(request.id);
        dispatched += 1;
      } catch (error) {
        await this.outbox.markFailed(request.id, error instanceof Error ? error.message : String(error));
        failed += 1;
      }
    }

    return { dispatched, failed };
  }
}
