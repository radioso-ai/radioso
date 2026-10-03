import { AppError } from "../../../shared/domain/errors.js";
import type {
  CustomerReplyOutboxPort,
  DeliveryFailureRecorderPort,
  DeliveryFailureResolverPort,
} from "../../customerReplyDelivery/public.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { emailSendKey, enqueueEmailSendAction, type EmailSendActionPayload } from "../outbound/emailSendAction.js";
import { operatorSendAuthority } from "../outbound/sendAuthority.js";
import { EMAIL_DELIVERY_PROVIDER } from "../outbound/sendIntentWriter.js";
import type { EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";
import type { EmailSendIntentRecord, EmailSendIntentRepository } from "../persistence/emailSendIntentRepository.js";
import { emailSendingRefusal } from "./emailSendingRefusal.js";

type Resolution = Parameters<DeliveryFailureResolverPort["resolve"]>[0];

/** Lost version races one decision is re-applied through before it is refused. */
const MAX_FENCE_ATTEMPTS = 3;

/**
 * A teammate's resolution, bound to one transaction by composition: the operator-resolution
 * transition on the send intent, the failure it clears and, for a resend, the new `email.send`
 * action. The composition pushes the action drain once it commits.
 */
export interface DeliveryResolutionScope {
  intents: Pick<EmailSendIntentRepository, "transition">;
  failures: Pick<DeliveryFailureRecorderPort, "clear">;
  outbox: CustomerReplyOutboxPort;
}

export interface DeliveryResolutionUnitOfWork {
  run<T>(work: (scope: DeliveryResolutionScope) => Promise<T>): Promise<T>;
}

const notResolvable = (): AppError =>
  new AppError(409, "not_resolvable", "This delivery failure cannot be resolved that way.");

type QueuedResend = { workspaceId: string; idempotencyKey: string; payload: EmailSendActionPayload };

/**
 * The email channel's half of a teammate's decision on a failed reply (FR-036, research B18). It
 * acts on the newest send of the failure's message:
 *
 * - `marked_sent` settles an `uncertain` send as sent;
 * - `resend` queues a new `email.send` of the same message under the next `…:resend:<n>` key,
 *   which the handler materializes and revalidates like any operator-authorized send. It is the
 *   only path to a second provider call for a message, and it never reuses an earlier key.
 *
 * Each decision is fenced twice in one transaction: on the intent's version, and on the failure
 * still being open, which it clears as `operator_resolved`. A resend refuses before any write
 * while the mailbox cannot send.
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
    const { failure, decision, userId } = resolution;
    if (failure.provider !== EMAIL_DELIVERY_PROVIDER || failure.messageId === null) throw notResolvable();
    const chain = await this.deps.intents.listByMessageId(failure.messageId);
    const intent = chain.at(-1);
    if (!intent || intent.workspaceId !== resolution.workspaceId || intent.conversationId !== failure.conversationId) {
      throw notResolvable();
    }
    const resend = decision === "resend" ? await this.prepareResend(intent, chain) : null;

    let expectedVersion = intent.version;
    for (let attempt = 1; attempt <= MAX_FENCE_ATTEMPTS; attempt += 1) {
      const outcome = await this.deps.unitOfWork.run(async (scope) => {
        const transition = await scope.intents.transition(intent.id, expectedVersion, { kind: "operator_resolution", decision, userId });
        if (transition.outcome === "conflict") return transition;
        if (transition.outcome !== "applied") throw notResolvable();
        const cleared = await scope.failures.clear({
          conversationId: intent.conversationId,
          messageId: intent.messageId,
          reason: "operator_resolved",
          userId,
        });
        if (cleared === 0) throw notResolvable();
        if (resend && transition.effects.some((effect) => effect.kind === "create_resend_intent")) {
          const queued = await enqueueEmailSendAction(scope.outbox, resend);
          // The key names the resend's number; a duplicate means another decision took it.
          if (queued.duplicate) throw notResolvable();
        }
        return transition;
      });
      if (outcome.outcome !== "conflict") return { sendIntentId: intent.id };
      this.deps.metrics?.incrementCounter("email_send_transition_conflicts_total", {
        help: "Send-intent transitions re-applied after losing the version fence, by writer.",
        labels: { writer: "operator" },
      });
      expectedVersion = outcome.current.version;
    }
    throw notResolvable();
  }

  /** The resend's action, or the refusal a mailbox that cannot send gets before any write. */
  private async prepareResend(intent: EmailSendIntentRecord, chain: readonly EmailSendIntentRecord[]): Promise<QueuedResend> {
    const mailbox = await this.deps.mailboxes.findById(intent.mailboxId);
    const domain = mailbox ? await this.deps.domains.findById(mailbox.domainId) : null;
    const verdict = operatorSendAuthority({ mailbox, domain });
    if (!mailbox || verdict.verdict === "halt") {
      throw emailSendingRefusal(verdict.verdict === "halt" ? verdict.haltReason : "mailbox_removed", domain?.domain ?? null);
    }
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
          ownershipVersion: await this.deps.ownership.versionOf(intent.conversationId),
          mode: mailbox.engagementMode,
          domainId: mailbox.domainId,
        },
      },
    };
  }
}
