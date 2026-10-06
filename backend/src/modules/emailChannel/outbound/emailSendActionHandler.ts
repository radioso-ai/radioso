import type { ActionHandler, ActionHandlerContext } from "../../chat/contracts/index.js";
import type { DeliveryFailureRecorderPort } from "../../customerReplyDelivery/public.js";
import type { HeldReplyDispatchPort } from "../../handoff/public.js";
import { parseRfcMessageId, type RfcMessageId } from "../../mail/public.js";
import { isHumanAuthoredMessageSource } from "../../../shared/domain/messageAuthorship.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { EmailChannelJobLogger } from "../emailChannelAudit.js";
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
import {
  firstAttemptAuthority,
  ownershipFactsOf,
  repostAuthorized,
  type EmailSendOwnershipReader,
  type SendOwnershipFacts,
} from "./sendAuthority.js";
import { DISPATCH_EXHAUSTED } from "./sendIntentTransitions.js";
import {
  countEmailSendIntentState,
  EMAIL_DELIVERY_PROVIDER,
  type EmailSendUnitOfWork,
  type SendIntentWriter,
} from "./sendIntentWriter.js";

/** The message a send delivers: its author and its text, read when the intent materializes and freezes. */
interface EmailSendMessageReader {
  findByIdAndWorkspaceId(
    workspaceId: string,
    messageId: string,
  ): Promise<{ id: string; conversationId: string; content: string; source?: string | null } | null>;
}

type SendFacts = { mailbox: EmailMailboxRecord | null; domain: EmailDomainRecord | null };
type AutoMaterialization = Awaited<ReturnType<HeldReplyDispatchPort["materializeAuto"]>>;
type FrozenRequest = SendRequestSnapshot & { body: NonNullable<SendRequestSnapshot["body"]> };

const isRfcMessageId = (value: RfcMessageId | null): value is RfcMessageId => value !== null;

/**
 * Another claim froze the request after this one read the intent, and may be in its provider call:
 * this claim writes nothing over that send. Thrown, so the outbox settles the claim: a superseded
 * claim's failure is dropped, and a current one is retried, finding the outcome the other claim
 * recorded or resuming the send if that claim stopped.
 */
class SendFrozenByAnotherClaimError extends Error {
  constructor() {
    super("email_send_frozen_by_another_claim");
    this.name = "SendFrozenByAnotherClaimError";
  }
}

/**
 * Delivers one `email.send` action (research B6). With no transaction held across the provider
 * call, it:
 *
 * 1. materializes the send intent under the outbox key, or loads it, and stops if it is done;
 * 2. on the first attempt only, rechecks the authority its trigger needs: that the mailbox may
 *    still send, and halts if not; for an automatic reply, also its automatic authority and the
 *    thread's budget, and fails it unsent if they narrowed;
 * 3. freezes the provider request, so every re-POST under the key is identical;
 * 4. sends it through the provider with the key;
 * 5. applies the outcome through the fenced transition (research B18);
 * 6. fetches the delivered Message-ID.
 *
 * After an unknown outcome the reconciler owns re-POSTs. The author is the message's: an unchanged
 * release is the agent's message and carries `Auto-Submitted: auto-generated`, an edited one is the
 * teammate's and does not (FR-034).
 *
 * The operator-authorized triggers — an operator reply, a held reply's release, an audited resend —
 * name their message, and step 1 writes their intent. An automatic reply names its held reply
 * instead (research B9): step 1 asks the held-reply dispatch port to materialize it, which
 * re-authorizes the send (FR-032) and writes the agent's message with its intent in one
 * transaction, or returns the draft to a teammate with nothing written. Once materialized it is
 * never a draft again. Step 2 checks its automatic authority again, so one recovered after the
 * worker stopped between materializing and freezing it never goes out on authority since revoked:
 * it fails unsent and flags its message. After an unknown outcome a revoked authority makes it
 * `uncertain`.
 *
 * Two claims can hold one action across a lease expiry. Steps 2 and 3 are fenced on the intent
 * read in step 1: whichever of the freeze and the unsent settlement lands first, the other is
 * refused, and the claim that lost to a freeze leaves the send to the claim that froze it
 * (research B18).
 */
export class EmailSendActionHandler implements ActionHandler {
  constructor(private readonly deps: {
    intents: Pick<EmailSendIntentRepository, "findByIdempotencyKey" | "freezeRequest">;
    unitOfWork: EmailSendUnitOfWork;
    messages: EmailSendMessageReader;
    mailboxes: Pick<EmailMailboxRepository, "findById">;
    domains: Pick<EmailDomainRepository, "findById">;
    threads: Pick<EmailThreadRepository, "findLink" | "findLatestInboundThreading">;
    /** Read for an automatic send's authority before its first attempt and before a re-POST. */
    ownership: EmailSendOwnershipReader;
    /** Turns a queued automatic reply into the message it sends (research B9). */
    heldReplies: Pick<HeldReplyDispatchPort, "materializeAuto">;
    attempt: Pick<ProviderSendAttempt, "send" | "withinRepostWindow" | "fetchDeliveredMessageId">;
    writer: Pick<SendIntentWriter, "apply">;
    /** In its own transaction: a send that never materialized has no intent to fence on. */
    failures: Pick<DeliveryFailureRecorderPort, "open">;
    /** The provider name intents record and provider events are correlated by. */
    provider: string;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    /** Logs each send the provider accepted, with ids only. */
    logger: EmailChannelJobLogger;
    createId: () => string;
  }) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const { payload, idempotencyKey } = readEmailSendAction(input.payload, input.context.idempotencyKey);
    const intent = payload.trigger === "auto_reply"
      ? await this.loadOrMaterializeAuto(payload, idempotencyKey)
      : await this.loadOrMaterialize(payload, idempotencyKey, input.context.workspaceId);
    if (intent) await this.advance(intent, input.context.attempt);
  }

  /**
   * The outbox gave up. A send never materialized still flags its message; one that never reached
   * an outcome becomes `failed`, or `uncertain` when its request was frozen, because a frozen
   * request may have reached the provider, and only an operator may decide to send it again. The
   * state machine decides which on the row as it is, so a freeze it did not read is still seen.
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
    await this.deps.writer.apply(intent, { kind: "dispatch_exhausted" }, { writer: "handler" });
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

  /**
   * Step 1 of an automatic reply: the intent under the held reply's key, materialized on the first
   * claim through the dispatch port. Null when nothing is to be sent: the held reply was superseded
   * while queued, or its authority had changed and it went back to a teammate.
   */
  private async loadOrMaterializeAuto(payload: EmailSendActionPayload, idempotencyKey: string): Promise<EmailSendIntentRecord | null> {
    const existing = await this.deps.intents.findByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    const { heldReplyId } = payload;
    if (heldReplyId === null) throw new Error("email_send_held_reply_missing");
    const materialized = await traceOperation({
      name: "email.send.materialize_auto",
      attributes: { "radioso.conversation_id": payload.conversationId },
      run: () => this.deps.heldReplies.materializeAuto(heldReplyId),
      resultAttributes: (result: AutoMaterialization) => ({ result: result.ok ? "materialized" : result.reason }),
    });
    this.deps.metrics?.incrementCounter("email_auto_dispatch_total", {
      help: "Automatic email replies at dispatch, by whether they were materialized.",
      labels: { result: materialized.ok ? "materialized" : materialized.reason },
    });
    if (!materialized.ok) {
      if (materialized.reason === "returned_to_pending") {
        this.deps.logger.warn({ conversationId: payload.conversationId, mailboxId: payload.mailboxId }, "email_auto_send_returned_to_pending");
      }
      return null;
    }
    const intent = await this.deps.intents.findByIdempotencyKey(idempotencyKey);
    if (!intent) throw new Error("email_send_intent_missing");
    countEmailSendIntentState(this.deps.metrics, intent);
    return intent;
  }

  /**
   * Steps 2 to 6 from the intent as this claim read it. `lostRace` once another claim moved it
   * after that read: a request that claim froze is its to send, never resumed alongside it.
   */
  private async advance(intent: EmailSendIntentRecord, attempt: number, lostRace = false): Promise<void> {
    if (intent.state === "accepted") {
      // A redelivery after a crash between the acceptance and step 6.
      await this.deps.attempt.fetchDeliveredMessageId(intent);
      return;
    }
    // Settled, halted and uncertain sends never go out again from here; after an unknown outcome
    // the reconciler re-POSTs on its schedule.
    if (intent.state !== "queued" || intent.outcomeUnknown) return;
    if (intent.request !== null) {
      if (lostRace) throw this.leftToFreezingClaim(intent, attempt);
      await this.resume(intent, attempt);
      return;
    }
    const moved = await this.checkAndFreeze(intent, attempt);
    // Another claim moved the intent first; continue from where it left it, once.
    if (moved && !lostRace) await this.advance(moved, attempt, true);
  }

  /**
   * Steps 2 and 3 on an intent this claim read unfrozen: the verdict lands as the freeze or as the
   * unsent settlement, each fenced on that read. Returns the intent as another claim left it when
   * that claim moved it first, and null once this claim's step landed.
   */
  private async checkAndFreeze(intent: EmailSendIntentRecord, attempt: number): Promise<EmailSendIntentRecord | null> {
    const facts = await this.sendFacts(intent);
    const verdict = await traceOperation({
      name: "email.send.revalidate",
      attributes: { trigger: intent.trigger, "radioso.workspace_id": intent.workspaceId, "radioso.email.send_intent_id": intent.id },
      run: async () => firstAttemptAuthority(intent, { ...facts, ...(await this.automaticFacts(intent)) }),
      resultAttributes: (checked) => ({
        result: checked.verdict === "allow" ? "allow" : checked.verdict === "halt" ? checked.haltReason : checked.code,
      }),
    });
    if (verdict.verdict !== "allow") {
      const settled = await this.deps.writer.apply(
        intent,
        verdict.verdict === "halt"
          ? { kind: "revalidation_failed", haltReason: verdict.haltReason }
          : { kind: "authority_revoked", code: verdict.code },
        { writer: "handler" },
      );
      if (settled.outcome === "ignored") return settled.intent;
      if (settled.outcome === "applied" && verdict.verdict === "revoked") {
        this.deps.logger.warn(
          { sendIntentId: intent.id, workspaceId: intent.workspaceId, conversationId: intent.conversationId, code: verdict.code },
          "email_auto_send_revoked_before_send",
        );
      }
      return null;
    }
    const frozen = await this.deps.intents.freezeRequest(intent.id, intent.version, await this.buildRequest(intent, facts));
    if (frozen.outcome === "not_found") return null;
    if (frozen.outcome === "conflict") return frozen.current;
    await this.send(frozen.intent, attempt);
    return null;
  }

  /** Another claim froze the request after this claim read it: that claim sends it and records the outcome. */
  private leftToFreezingClaim(intent: EmailSendIntentRecord, attempt: number): SendFrozenByAnotherClaimError {
    this.deps.logger.warn(
      { sendIntentId: intent.id, workspaceId: intent.workspaceId, conversationId: intent.conversationId, attempt },
      "email_send_left_to_freezing_claim",
    );
    return new SendFrozenByAnotherClaimError();
  }

  /**
   * A frozen request with no recorded outcome: an earlier claim may have reached the provider before
   * it stopped. It is re-POSTed under the same key, and only while the send is still authorized and
   * the key inside its window; otherwise it is `uncertain` and goes to an operator.
   */
  private async resume(intent: EmailSendIntentRecord, attempt: number): Promise<void> {
    const facts = await this.sendFacts(intent);
    const ownership = intent.trigger === "auto_reply" ? await this.deps.ownership.load(intent.conversationId) : null;
    const authorityValid = repostAuthorized(intent, { ...facts, ownership: ownershipFactsOf(ownership) });
    const withinWindow = this.deps.attempt.withinRepostWindow(intent);
    if (!authorityValid || !withinWindow) {
      await this.deps.writer.apply(intent, { kind: "outcome_unknown", authorityValid, withinWindow }, { writer: "handler" });
      return;
    }
    await this.send(intent, attempt);
  }

  /** POSTs the frozen request, and logs the send when the provider accepted it. */
  private async send(intent: EmailSendIntentRecord, attempt: number): Promise<void> {
    const sent = await this.deps.attempt.send(intent, { writer: "handler", attempt });
    if (sent.state !== "accepted") return;
    this.deps.logger.info(
      {
        sendIntentId: sent.id,
        workspaceId: sent.workspaceId,
        mailboxId: sent.mailboxId,
        conversationId: sent.conversationId,
        trigger: sent.trigger,
        attempt,
      },
      "email_send_accepted",
    );
  }

  /**
   * What only an automatic send's authority reads: the conversation's ownership and the thread's
   * automatic sends since its budget was renewed, this one's reservation among them. An
   * operator-authorized send reads neither.
   */
  private async automaticFacts(intent: EmailSendIntentRecord): Promise<{ ownership: SendOwnershipFacts; reservedAutoSends: number | null }> {
    if (intent.trigger !== "auto_reply") return { ownership: ownershipFactsOf(null), reservedAutoSends: null };
    const [ownership, link] = await Promise.all([
      this.deps.ownership.load(intent.conversationId),
      this.deps.threads.findLink(intent.conversationId),
    ]);
    return { ownership: ownershipFactsOf(ownership), reservedAutoSends: link?.autoSendsSinceRenewal ?? null };
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
