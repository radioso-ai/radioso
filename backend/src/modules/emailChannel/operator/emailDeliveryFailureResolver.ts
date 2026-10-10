import { AppError } from "../../../shared/domain/errors.js";
import type {
  CustomerReplyOutboxPort,
  DeliveryFailureLockPort,
  DeliveryFailureRecorderPort,
  DeliveryFailureResolverPort,
} from "../../customerReplyDelivery/public.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { emailSendKey, enqueueEmailSendAction, type EmailSendActionPayload } from "../outbound/emailSendAction.js";
import { operatorSendAuthority } from "../outbound/sendAuthority.js";
import { EMAIL_DELIVERY_PROVIDER } from "../outbound/sendIntentWriter.js";
import type { EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRecord, EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";
import type { EmailSendIntentRecord, EmailSendIntentRepository } from "../persistence/emailSendIntentRepository.js";
import { emailSendingRefusal } from "./emailSendingRefusal.js";

type Resolution = Parameters<DeliveryFailureResolverPort["resolve"]>[0];

/** Lost version races one decision is re-applied through before it is refused. */
const MAX_FENCE_ATTEMPTS = 3;

/**
 * A teammate's resolution, bound to one transaction by composition: the operator-resolution
 * transition on the send intent, the failure it locks and clears and, for a resend, the new
 * `email.send` action. The composition pushes the action drain once it commits.
 */
export interface DeliveryResolutionScope {
  intents: Pick<EmailSendIntentRepository, "transition" | "listByMessageId">;
  failures: Pick<DeliveryFailureRecorderPort, "clear"> & DeliveryFailureLockPort;
  outbox: CustomerReplyOutboxPort;
}

export interface DeliveryResolutionUnitOfWork {
  run<T>(work: (scope: DeliveryResolutionScope) => Promise<T>): Promise<T>;
}

const notResolvable = (): AppError =>
  new AppError(409, "not_resolvable", "This delivery failure cannot be resolved that way.");

/** What a resend is sent as, read before the transaction: the mailbox that may send it and the ownership it is queued at. */
type ResendAuthority = { mailbox: EmailMailboxRecord; ownershipVersion: number };

/**
 * The email channel's half of a teammate's decision on a failed reply (FR-036, research B18). It
 * acts on the send whose failure the teammate decided on, the newest send of its message:
 *
 * - `marked_sent` settles an `uncertain` send as sent;
 * - `resend` queues a new `email.send` of the same message under the next `…:resend:<n>` key,
 *   which the handler materializes and revalidates like any operator-authorized send. It is the
 *   only path to a second provider call for a message, and it never reuses an earlier key.
 *
 * Each decision is fenced twice in one transaction: on the send's version, and on the very failure
 * the teammate named, locked while it is still open and as they read it, and cleared by its id as
 * `operator_resolved`. A stale request whose failure a resend already replaced with a newer one is
 * refused, never applied to the newer one. The send is transitioned before the failure is locked,
 * the order the send path writes them in. A resend refuses before any write while the mailbox
 * cannot send.
 */
export class EmailDeliveryFailureResolver implements DeliveryFailureResolverPort {
  constructor(private readonly deps: {
    intents: Pick<EmailSendIntentRepository, "listByMessageId">;
    mailboxes: Pick<EmailMailboxRepository, "findById">;
    domains: Pick<EmailDomainRepository, "findById">;
    /** The conversation's ownership version, 0 before any ownership change. */
    ownership: { versionOf(conversationId: string): Promise<number> };
    unitOfWork: DeliveryResolutionUnitOfWork;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  }) {}

  async resolve(resolution: Resolution): Promise<{ sendIntentId: string }> {
    const { failure, decision, userId, workspaceId } = resolution;
    const messageId = failure.messageId;
    if (failure.provider !== EMAIL_DELIVERY_PROVIDER || messageId === null) throw notResolvable();
    const read = (await this.deps.intents.listByMessageId(messageId)).at(-1);
    if (!read || !this.sendsFailure(read, resolution)) throw notResolvable();
    // Read and refused before the transaction: nothing it decides may hold the transaction's locks.
    const resendAuthority = decision === "resend" ? await this.resendAuthority(read) : null;

    for (let attempt = 1; attempt <= MAX_FENCE_ATTEMPTS; attempt += 1) {
      const outcome = await this.deps.unitOfWork.run(async (scope) => {
        const chain = await scope.intents.listByMessageId(messageId);
        const intent = chain.at(-1);
        if (!intent || !this.sendsFailure(intent, resolution) || (resendAuthority && intent.mailboxId !== resendAuthority.mailbox.id)) {
          throw notResolvable();
        }
        const transition = await scope.intents.transition(intent.id, intent.version, { kind: "operator_resolution", decision, userId });
        if (transition.outcome === "conflict") return transition;
        if (transition.outcome !== "applied") throw notResolvable();
        // The failure the teammate decided on, still open and as they read it: a failure cleared
        // meanwhile, or one a late provider event settled into another kind, refuses the decision.
        const locked = await scope.failures.lockOpen({ workspaceId, failureId: failure.id });
        if (!locked || locked.kind !== failure.kind || locked.messageId !== messageId || locked.conversationId !== intent.conversationId) {
          throw notResolvable();
        }
        await scope.failures.clear({ reason: "operator_resolved", failureId: locked.id, userId });
        if (resendAuthority && transition.effects.some((effect) => effect.kind === "create_resend_intent")) {
          const queued = await enqueueEmailSendAction(scope.outbox, this.resendAction(intent, chain, resendAuthority));
          // The key names the resend's number; a duplicate means another decision took it.
          if (queued.duplicate) throw notResolvable();
        }
        return { outcome: "applied" as const, sendIntentId: intent.id };
      });
      if (outcome.outcome === "applied") return { sendIntentId: outcome.sendIntentId };
      this.deps.metrics?.incrementCounter("email_send_transition_conflicts_total", {
        help: "Send-intent transitions re-applied after losing the version fence, by writer.",
        labels: { writer: "operator" },
      });
    }
    throw notResolvable();
  }

  /** Whether the send is the workspace's send on the failure's conversation. */
  private sendsFailure(intent: EmailSendIntentRecord, resolution: Resolution): boolean {
    return intent.workspaceId === resolution.workspaceId && intent.conversationId === resolution.failure.conversationId;
  }

  /** The mailbox a resend goes out as, or the refusal a mailbox that cannot send gets before any write. */
  private async resendAuthority(intent: EmailSendIntentRecord): Promise<ResendAuthority> {
    const mailbox = await this.deps.mailboxes.findById(intent.mailboxId);
    const domain = mailbox ? await this.deps.domains.findById(mailbox.domainId) : null;
    const verdict = operatorSendAuthority({ mailbox, domain });
    if (!mailbox || verdict.verdict === "halt") {
      throw emailSendingRefusal(verdict.verdict === "halt" ? verdict.haltReason : "mailbox_removed", domain?.domain ?? null);
    }
    return { mailbox, ownershipVersion: await this.deps.ownership.versionOf(intent.conversationId) };
  }

  /** The resend's action, numbered after every resend of the message before it. */
  private resendAction(
    intent: EmailSendIntentRecord,
    chain: readonly EmailSendIntentRecord[],
    { mailbox, ownershipVersion }: ResendAuthority,
  ): { workspaceId: string; idempotencyKey: string; payload: EmailSendActionPayload } {
    const resendNumber = chain.filter((sent) => sent.trigger === "audited_resend").length + 1;
    return {
      workspaceId: intent.workspaceId,
      idempotencyKey: emailSendKey.resend(intent.messageId, resendNumber),
      payload: {
        version: 1,
        trigger: "audited_resend",
        mailboxId: mailbox.id,
        conversationId: intent.conversationId,
        messageId: intent.messageId,
        heldReplyId: null,
        authority: {
          policyVersion: mailbox.policyVersion,
          ownershipVersion,
          mode: mailbox.engagementMode,
          domainId: mailbox.domainId,
        },
      },
    };
  }
}
