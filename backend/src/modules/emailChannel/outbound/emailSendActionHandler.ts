import type { ActionHandler, ActionHandlerContext } from "../../chat/contracts/index.js";
import type { DeliveryFailureRecorderPort } from "../../customerReplyDelivery/public.js";
import { parseRfcMessageId, type RfcMessageId } from "../../mail/public.js";
import { isHumanAuthoredMessageSource } from "../../../shared/domain/messageAuthorship.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { EmailChannelLogger } from "../emailChannelAudit.js";
import type { EmailDomainRecord, EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRecord, EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";
import type {
  EmailSendIntentRecord,
  EmailSendIntentRepository,
  SendRequestSnapshot,
} from "../persistence/emailSendIntentRepository.js";
import type { EmailThreadRepository } from "../persistence/emailThreadRepository.js";
import { readEmailSendAction, type EmailSendActionPayload } from "./emailSendAction.js";
import { buildOutboundHeaders, outboundMessageId, replySubject, replyToAddress } from "./outboundHeaders.js";
import type { ProviderSendAttempt } from "./providerSendAttempt.js";
import { operatorSendAuthority } from "./sendAuthority.js";
import {
  countEmailSendIntentState,
  EMAIL_DELIVERY_PROVIDER,
  type EmailSendUnitOfWork,
  type SendIntentWriter,
} from "./sendIntentWriter.js";

/** The failure code of a send the outbox gave up on before any outcome was recorded. */
const DISPATCH_EXHAUSTED = "dispatch_exhausted";

/** The message a send delivers: its author and its text, read when the intent materializes and freezes. */
interface EmailSendMessageReader {
  findByIdAndWorkspaceId(
    workspaceId: string,
    messageId: string,
  ): Promise<{ id: string; conversationId: string; content: string; source?: string | null } | null>;
}

type SendFacts = { mailbox: EmailMailboxRecord | null; domain: EmailDomainRecord | null };
type FrozenRequest = SendRequestSnapshot & { body: NonNullable<SendRequestSnapshot["body"]> };

const isRfcMessageId = (value: RfcMessageId | null): value is RfcMessageId => value !== null;

/**
 * Delivers one `email.send` action (research B6). With no transaction held across the provider
 * call, it:
 *
 * 1. materializes the send intent under the outbox key, or loads it, and stops if it is done;
 * 2. on the first attempt only, rechecks that the mailbox may still send, and halts if not;
 * 3. freezes the provider request, so every re-POST under the key is identical;
 * 4. sends it through the provider with the key;
 * 5. applies the outcome through the fenced transition (research B18);
 * 6. fetches the delivered Message-ID.
 *
 * After an unknown outcome the reconciler owns re-POSTs. It delivers the operator-authorized
 * triggers: an operator reply, a held reply's release, and an audited resend. The author is the
 * message's: an unchanged release is the agent's message and carries `Auto-Submitted:
 * auto-generated`, an edited one is the teammate's and does not (FR-034). `auto_reply` materializes
 * through the held-reply dispatch port (research B9).
 */
export class EmailSendActionHandler implements ActionHandler {
  constructor(private readonly deps: {
    intents: Pick<EmailSendIntentRepository, "findByIdempotencyKey" | "freezeRequest">;
    unitOfWork: EmailSendUnitOfWork;
    messages: EmailSendMessageReader;
    mailboxes: Pick<EmailMailboxRepository, "findById">;
    domains: Pick<EmailDomainRepository, "findById">;
    threads: Pick<EmailThreadRepository, "findLink" | "findLatestInboundThreading">;
    attempt: Pick<ProviderSendAttempt, "send" | "withinRepostWindow" | "fetchDeliveredMessageId">;
    writer: Pick<SendIntentWriter, "apply">;
    /** In its own transaction: a send that never materialized has no intent to fence on. */
    failures: Pick<DeliveryFailureRecorderPort, "open">;
    /** The provider name intents record and provider events are correlated by. */
    provider: string;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    logger: EmailChannelLogger;
    createId: () => string;
  }) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const action = readEmailSendAction(input.payload, input.context.idempotencyKey);
    if (action.payload.trigger === "auto_reply") {
      throw new Error("email_send_auto_reply_unavailable");
    }
    const intent = await this.loadOrMaterialize(action.payload, action.idempotencyKey, input.context.workspaceId);
    await this.advance(intent, input.context.attempt, true);
  }

  /**
   * The outbox gave up. A send never materialized still flags its message; one that never reached
   * an outcome becomes `failed`, or `uncertain` when its request was frozen, because a frozen
   * request may have reached the provider, and only an operator may decide to send it again.
   */
  async recordFailureOutcome(input: {
    payload: Record<string, unknown>;
    context: ActionHandlerContext;
    outcome: "retry" | "failed";
    error: string;
  }): Promise<void> {
    if (input.outcome !== "failed") return;
    let action: ReturnType<typeof readEmailSendAction>;
    try {
      action = readEmailSendAction(input.payload, input.context.idempotencyKey);
    } catch {
      return;
    }
    const { payload } = action;
    this.deps.logger.warn(
      { conversationId: payload.conversationId, workspaceId: input.context.workspaceId, trigger: payload.trigger },
      "email_send_dispatch_exhausted",
    );
    const intent = await this.deps.intents.findByIdempotencyKey(action.idempotencyKey);
    if (!intent) {
      if (payload.messageId !== null && input.context.workspaceId !== null) {
        await this.deps.failures.open({
          workspaceId: input.context.workspaceId,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          provider: EMAIL_DELIVERY_PROVIDER,
          kind: "failed",
          detailCode: DISPATCH_EXHAUSTED,
        });
      }
      return;
    }
    if (intent.state !== "queued") return;
    const mayHaveSent = intent.outcomeUnknown || intent.request !== null;
    await this.deps.writer.apply(
      intent,
      mayHaveSent
        ? { kind: "outcome_unknown", authorityValid: true, withinWindow: false }
        : { kind: "provider_rejected", code: DISPATCH_EXHAUSTED },
      { writer: "handler" },
    );
  }

  // ── Steps ──────────────────────────────────────────────────────────

  /** Step 1: the intent under the key, written on the first claim with the message's author. */
  private async loadOrMaterialize(payload: EmailSendActionPayload, idempotencyKey: string, workspaceId: string | null): Promise<EmailSendIntentRecord> {
    const existing = await this.deps.intents.findByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    const messageId = payload.messageId;
    if (messageId === null) throw new Error("email_send_message_missing");
    const mailbox = await this.deps.mailboxes.findById(payload.mailboxId);
    if (!mailbox || (workspaceId !== null && mailbox.workspaceId !== workspaceId)) {
      throw new Error("email_send_mailbox_not_found");
    }
    const domain = await this.deps.domains.findById(mailbox.domainId);
    if (!domain) throw new Error("email_send_domain_not_found");
    const message = await this.deps.messages.findByIdAndWorkspaceId(mailbox.workspaceId, messageId);
    if (!message || message.conversationId !== payload.conversationId) throw new Error("email_send_message_not_found");

    const id = this.deps.createId();
    const { intent, created } = await this.deps.unitOfWork.run(async (scope) => {
      const materialized = await scope.intents.materialize({
        id,
        workspaceId: mailbox.workspaceId,
        mailboxId: mailbox.id,
        conversationId: payload.conversationId,
        messageId,
        heldReplyId: payload.heldReplyId,
        idempotencyKey,
        authorKind: isHumanAuthoredMessageSource(message.source) ? "operator" : "agent",
        trigger: payload.trigger,
        authority: payload.authority,
        provider: this.deps.provider,
        suppliedRfcMessageId: outboundMessageId(domain.domain, id),
      });
      // Every trigger this handler materializes is operator-authorized, which renews the thread's
      // automatic-send budget (research B8).
      if (materialized.created) await scope.threads.renewSendBudget(payload.conversationId);
      return materialized;
    });
    if (created) countEmailSendIntentState(this.deps.metrics, intent);
    return intent;
  }

  private async advance(intent: EmailSendIntentRecord, attempt: number, mayRetryFreeze: boolean): Promise<void> {
    if (intent.state === "accepted") {
      // A redelivery after a crash between the acceptance and step 6.
      await this.deps.attempt.fetchDeliveredMessageId(intent);
      return;
    }
    // Settled, halted and uncertain sends never go out again from here; after an unknown outcome
    // the reconciler re-POSTs on its schedule.
    if (intent.state !== "queued" || intent.outcomeUnknown) return;
    if (intent.request !== null) {
      await this.resume(intent, attempt);
      return;
    }

    const facts = await this.sendFacts(intent);
    const verdict = await traceOperation({
      name: "email.send.revalidate",
      attributes: { trigger: intent.trigger, "radioso.workspace_id": intent.workspaceId, "radioso.email.send_intent_id": intent.id },
      run: () => operatorSendAuthority(facts),
      resultAttributes: (checked) => ({ result: checked.verdict === "allow" ? "allow" : checked.haltReason }),
    });
    if (verdict.verdict === "halt") {
      await this.deps.writer.apply(intent, { kind: "revalidation_failed", haltReason: verdict.haltReason }, { writer: "handler" });
      return;
    }
    const frozen = await this.deps.intents.freezeRequest(intent.id, intent.version, await this.buildRequest(intent, facts));
    if (frozen.outcome === "not_found") return;
    if (frozen.outcome === "conflict") {
      // Another claim moved the intent first; continue from where it left it, once.
      if (mayRetryFreeze) await this.advance(frozen.current, attempt, false);
      return;
    }
    await this.deps.attempt.send(frozen.intent, { writer: "handler", attempt });
  }

  /**
   * A frozen request with no recorded outcome: an earlier claim may have reached the provider before
   * it stopped. It is re-POSTed under the same key, and only while the send is still authorized and
   * the key inside its window; otherwise it is `uncertain` and goes to an operator.
   */
  private async resume(intent: EmailSendIntentRecord, attempt: number): Promise<void> {
    const authorityValid = operatorSendAuthority(await this.sendFacts(intent)).verdict === "allow";
    const withinWindow = this.deps.attempt.withinRepostWindow(intent);
    if (!authorityValid || !withinWindow) {
      await this.deps.writer.apply(intent, { kind: "outcome_unknown", authorityValid, withinWindow }, { writer: "handler" });
      return;
    }
    await this.deps.attempt.send(intent, { writer: "handler", attempt });
  }

  private async sendFacts(intent: EmailSendIntentRecord): Promise<SendFacts> {
    const mailbox = await this.deps.mailboxes.findById(intent.mailboxId);
    const domain = mailbox ? await this.deps.domains.findById(mailbox.domainId) : null;
    return { mailbox, domain };
  }

  /** Step 3's request: the mailbox's real address, the thread's headers and the message's text. */
  private async buildRequest(intent: EmailSendIntentRecord, facts: SendFacts): Promise<FrozenRequest> {
    const { mailbox, domain } = facts;
    if (!mailbox || !domain) throw new Error("email_send_mailbox_not_found");
    const [link, latest, message] = await Promise.all([
      this.deps.threads.findLink(intent.conversationId),
      this.deps.threads.findLatestInboundThreading(intent.conversationId),
      this.deps.messages.findByIdAndWorkspaceId(intent.workspaceId, intent.messageId),
    ]);
    if (!link) throw new Error("email_send_thread_not_found");
    if (!message) throw new Error("email_send_message_not_found");
    return {
      from: { email: mailbox.address, name: mailbox.displayName },
      to: link.participantAddress,
      replyTo: replyToAddress({ address: mailbox.address, plusAddressVerified: mailbox.plusAddressVerifiedAt !== null }, link.threadToken),
      subject: replySubject(link.latestSubject),
      threading: buildOutboundHeaders({
        sendingDomain: domain.domain,
        latestInbound: {
          rfcMessageId: latest ? parseRfcMessageId(latest.rfcMessageId) : null,
          references: (latest?.referenceIds ?? []).map((id) => parseRfcMessageId(id)).filter(isRfcMessageId),
        },
        authorKind: intent.authorKind,
        newMessageUuid: intent.id,
      }),
      body: { text: message.content, html: null },
    };
  }
}
