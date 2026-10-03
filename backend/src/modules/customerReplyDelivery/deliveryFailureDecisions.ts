import { AppError, notFound } from "../../shared/domain/errors.js";
import type { AuditService } from "../audit/contracts/index.js";
import type { DeliveryFailureKind, DeliveryFailurePage, DeliveryFailureRecord, DeliveryFailures } from "./deliveryFailures.js";

/** `marked_sent` settles an uncertain send as sent; `resend` sends the same reply once more. */
type DeliveryFailureDecision = "marked_sent" | "resend";

/**
 * The decisions a failure of each kind admits. Only a send nobody knows the outcome of can be
 * marked sent; a reply that never went out, or whose outcome is unknown, can be sent again. A bounce
 * or a refusal is the provider's answer, so a teammate can only acknowledge it.
 */
const DECISIONS_BY_KIND: Readonly<Record<DeliveryFailureKind, readonly DeliveryFailureDecision[]>> = {
  uncertain: ["marked_sent", "resend"],
  halted: ["resend"],
  bounced: [],
  failed: [],
};

interface DeliveryFailureResolution {
  workspaceId: string;
  failure: DeliveryFailureRecord;
  decision: DeliveryFailureDecision;
  userId: string;
}

/**
 * The delivering channel's half of a teammate's resolution. In one unit of work it settles the
 * channel's own record of the send, for `resend` queues a new send of the same reply, and clears the
 * failure as `operator_resolved`, fenced on the failure still being open. It refuses before any
 * write when the channel cannot send (`409 email_sending_not_verified`), and with `409
 * not_resolvable` when the failure cleared meanwhile. Returns the send the decision settled or queued.
 */
export interface DeliveryFailureResolverPort {
  resolve(resolution: DeliveryFailureResolution): Promise<{ sendIntentId: string }>;
}

/** The signed-in teammate deciding: delivery decisions are never a machine credential's. */
export interface DeliveryFailureActor {
  accountId: string;
  workspaceId: string;
  userId: string;
}

type DeliveryFailureStore = Pick<DeliveryFailures, "acknowledge" | "find" | "list">;

const notResolvable = (): AppError =>
  new AppError(409, "not_resolvable", "This delivery failure cannot be resolved that way.");

/**
 * A teammate's decisions on replies that may not have reached the customer: list them, acknowledge
 * one, or resolve one through the channel that carried it. Every decision is audited as
 * `hitl.delivery_failure`, naming the teammate.
 */
export class DeliveryFailureDecisions {
  constructor(private readonly deps: {
    failures: DeliveryFailureStore;
    /** Null when no delivering channel that settles resolutions is composed. */
    resolver: DeliveryFailureResolverPort | null;
    audit: Pick<AuditService, "record">;
    logger: { warn(fields: Record<string, unknown>, message: string): void };
  }) {}

  list(
    workspaceId: string,
    query: { state: "open" | "all"; agentId?: string; cursor?: string; limit: number },
  ): Promise<DeliveryFailurePage> {
    return this.deps.failures.list(workspaceId, query);
  }

  async acknowledge(actor: DeliveryFailureActor, failureId: string): Promise<DeliveryFailureRecord> {
    const acknowledged = await this.deps.failures.acknowledge({ workspaceId: actor.workspaceId, failureId, userId: actor.userId });
    if (!acknowledged) {
      await this.requireFailure(actor.workspaceId, failureId);
      throw new AppError(409, "already_cleared", "This delivery failure is already cleared.");
    }
    await this.recordAudit(actor, {
      action: "acknowledged",
      failureId,
      conversationId: acknowledged.conversationId,
      provider: acknowledged.provider,
      kind: acknowledged.kind,
    });
    return acknowledged;
  }

  async resolve(actor: DeliveryFailureActor, failureId: string, decision: DeliveryFailureDecision): Promise<DeliveryFailureRecord> {
    const failure = await this.requireFailure(actor.workspaceId, failureId);
    const { resolver } = this.deps;
    if (failure.clearedAt !== null || !DECISIONS_BY_KIND[failure.kind].includes(decision) || !resolver) {
      throw notResolvable();
    }
    const { sendIntentId } = await resolver.resolve({ workspaceId: actor.workspaceId, failure, decision, userId: actor.userId });
    await this.recordAudit(actor, { action: "resolved", failureId, conversationId: failure.conversationId, sendIntentId, decision });
    return (await this.deps.failures.find(actor.workspaceId, failureId)) ?? failure;
  }

  private async requireFailure(workspaceId: string, failureId: string): Promise<DeliveryFailureRecord> {
    const failure = await this.deps.failures.find(workspaceId, failureId);
    if (!failure) throw notFound("Delivery failure was not found");
    return failure;
  }

  /**
   * The decision has already committed, so a failed audit write is logged by ids and never thrown:
   * a caller told a committed decision failed would retry it, and a retried resend sends twice.
   */
  private async recordAudit(
    actor: DeliveryFailureActor,
    metadata: { action: "acknowledged" | "resolved"; failureId: string; conversationId: string } & Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        accountId: actor.accountId,
        workspaceId: actor.workspaceId,
        eventType: "hitl.delivery_failure",
        eventStatus: "success",
        metadata: { ...metadata, actorUserId: actor.userId },
      });
    } catch (error) {
      this.deps.logger.warn(
        {
          event: "delivery_failure_audit_failed",
          action: metadata.action,
          workspaceId: actor.workspaceId,
          failureId: metadata.failureId,
          conversationId: metadata.conversationId,
          actorUserId: actor.userId,
          errorClass: error instanceof Error ? error.name : typeof error,
        },
        "Delivery failure audit record failed after the decision committed",
      );
    }
  }
}
