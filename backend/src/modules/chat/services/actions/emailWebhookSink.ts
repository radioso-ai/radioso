import type { AgentContactWebhook } from "../../../agents/public.js";
import {
  formatRoutineEndingNotification,
  type OperatorNotification,
  type OperatorNotificationContext,
  type NotificationDeliveryAdmissionPort,
  type OperatorNotificationSink,
  type OperatorNotificationSinkOutcome,
  type RoutineEndingOperatorNotification,
  type NotificationRecipientPolicyService,
} from "../../../operatorNotifications/public.js";
import {
  resolveConversationLink,
  type ConversationLinkResolver,
} from "../../../../shared/domain/conversationLinkResolver.js";
import { mailDeliverySkipReason } from "../../../../shared/domain/mailDeliveryOutcome.js";
import type {
  ContactNotificationMailer,
  ContactWebhookHttpClient,
  RoutedContactRecipientResolver,
} from "./contactSendActionHandler.js";
import { createSignedWebhookHeaders } from "./webhookDelivery.js";

/** What this sink logs. Lines name the route and counts, never an address or a webhook URL. */
interface OperatorNotificationSinkLogger {
  warn(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
}

/**
 * The webhook carried a relative `dashboardPath` before it carried the absolute `dashboardUrl`.
 * The path is kept for one release so a consumer prefixing its own origin keeps working — now
 * with a path the dashboard routes — and is `null` whenever the URL is.
 */
const deprecatedDashboardPath = (dashboardUrl: string | null): string | null => {
  if (!dashboardUrl) {
    return null;
  }
  try {
    const url = new URL(dashboardUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
};

/**
 * This transport's wording per notification kind: the action type the no-recipient log line
 * names, and the error a webhook delivery without a client raises.
 */
const TRANSPORT_TEXT_BY_KIND: Record<OperatorNotification["kind"], { actionType: string; missingWebhookClientMessage: string }> = {
  approval: { actionType: "approval.request", missingWebhookClientMessage: "Approval request webhook delivery is not configured" },
  handoff: { actionType: "handoff.notify", missingWebhookClientMessage: "Handoff webhook delivery is not configured" },
  completion: { actionType: "completion.notify", missingWebhookClientMessage: "Completion notice webhook delivery is not configured" },
};

/**
 * Delivers operator notifications over the existing contact transport (workspace recipient emails +
 * signed webhook). It lives in the chat module — alongside the contact mailer/recipients/webhook it
 * wraps — and implements the neutral `OperatorNotificationSink` port, so the `operatorNotifications`
 * seam stays dependency-free. Behavior matches the previous `ApprovalRequestActionHandler` delivery
 * byte-for-byte (subject, text, idempotency keys).
 */
export class EmailWebhookOperatorNotificationSink implements OperatorNotificationSink {
  constructor(
    private readonly mailer: ContactNotificationMailer,
    private readonly recipients: RoutedContactRecipientResolver,
    private readonly logger?: OperatorNotificationSinkLogger,
    private readonly webhookClient?: ContactWebhookHttpClient,
    private readonly conversationLinks?: ConversationLinkResolver,
    private readonly admission?: NotificationDeliveryAdmissionPort,
    private readonly recipientPolicy?: Pick<NotificationRecipientPolicyService, "prepareDelivery">,
  ) {}

  async deliver(notification: OperatorNotification, context: OperatorNotificationContext): Promise<OperatorNotificationSinkOutcome> {
    const recipientContext = {
      requestId: context.requestId,
      workspaceId: context.workspaceId ?? notification.workspaceId,
      accountId: context.accountId ?? null,
      conversationId: context.conversationId ?? notification.conversationId,
      idempotencyKey: context.idempotencyKey ?? null,
      attempt: context.attempt ?? 1,
      // A routine ending's notice may name the notify skill that sends it; an approval never does.
      skillName: context.skillName ?? null,
    };
    const target = await this.recipients.resolve(recipientContext);
    if (recipientContext.skillName && target.via !== "named_skill") {
      // Delivery still goes to the default destination: a hand-off notice is the only alert that
      // someone is waiting for a person, so dropping it is worse than sending it to the default.
      this.logger?.warn(
        {
          kind: notification.kind,
          workspaceId: recipientContext.workspaceId,
          conversationId: recipientContext.conversationId,
          skillName: recipientContext.skillName,
          via: target.via,
        },
        "operator_notice_named_skill_unavailable",
      );
    }
    if (target.emails.length === 0 && !target.webhook) {
      const { actionType } = TRANSPORT_TEXT_BY_KIND[notification.kind];
      this.logger?.warn(
        { workspaceId: context.workspaceId ?? notification.workspaceId, conversationId: context.conversationId ?? notification.conversationId, via: target.via },
        `${actionType}: no recipient configured for workspace; skipping`,
      );
      return { disposition: "skipped", reason: "contact_destination_not_configured" };
    }
    const baseIdempotencyKey = context.idempotencyKey ?? context.requestId;
    const recipientDecision = this.recipientPolicy
      ? await this.recipientPolicy.prepareDelivery({
          workspaceId: recipientContext.workspaceId,
          agentId: notification.agentId,
          conversationId: recipientContext.conversationId,
          emails: target.emails,
          idempotencyKey: baseIdempotencyKey,
        })
      : {
          eligibleEmails: target.emails,
          eligibleRecipients: target.emails.map((email) => ({ email, listUnsubscribeUrl: "" })),
          skipped: { unconfirmed: 0, suppressed: 0 },
        };
    const admission = await this.admission?.admit({
      requestId: context.requestId,
      workspaceId: recipientContext.workspaceId,
      accountId: recipientContext.accountId,
      conversationId: recipientContext.conversationId,
      recipientEmails: recipientDecision.eligibleEmails,
      requestedEmailCount: recipientDecision.eligibleEmails.length,
    });
    if (admission && !admission.dispatchAllowed) {
      return { disposition: "skipped", reason: admission.reason ?? "conversation_dispatch_cap" };
    }
    this.logger?.info(
      { kind: notification.kind, via: target.via, emailCount: target.emails.length, webhook: target.webhook !== null },
      "operator_notice_routed",
    );

    const conversationUrl = await resolveConversationLink(
      this.conversationLinks,
      { workspaceId: notification.workspaceId, conversationId: notification.conversationId },
      this.logger,
    );
    const openLine = conversationUrl ? [`Open: ${conversationUrl}`] : [];
    const links = { dashboardUrl: conversationUrl, dashboardPath: deprecatedDashboardPath(conversationUrl) };

    const delivery = notification.kind === "approval"
      ? {
          subject: "Conversation needs an approval",
          replyTo: null,
          text: [
            "A conversation is waiting for an approval decision.",
            "",
            `Conversation: ${notification.conversationId}`,
            `Workspace: ${notification.workspaceId}`,
            `Agent: ${notification.agentId}`,
            `Decision: ${notification.handle}`,
            ...openLine,
          ].join("\n"),
          webhookPayload: {
            workspaceId: notification.workspaceId,
            agentId: notification.agentId,
            conversationId: notification.conversationId,
            handle: notification.handle,
            ...links,
            requestId: context.requestId,
          },
        }
      : this.routineEndingDelivery(notification, context, openLine, links);

    const [emailResults] = await Promise.all([
      Promise.all((admission?.emailAllowed === false ? [] : recipientDecision.eligibleRecipients).map((recipient) =>
        this.mailer.send({
          to: recipient.email,
          kind: "operator_notice",
          ...(delivery.replyTo ? { replyTo: delivery.replyTo } : {}),
          subject: delivery.subject,
          text: delivery.text,
          ...(recipient.listUnsubscribeUrl ? { listUnsubscribeUrl: recipient.listUnsubscribeUrl } : {}),
          idempotencyKey: `${baseIdempotencyKey}:email:${encodeURIComponent(recipient.email)}`,
        })),
      ),
      target.webhook ? this.postWebhook({
        webhook: target.webhook,
        payload: delivery.webhookPayload,
        idempotencyKey: `${baseIdempotencyKey}:webhook`,
        missingClientMessage: TRANSPORT_TEXT_BY_KIND[notification.kind].missingWebhookClientMessage,
      }) : Promise.resolve(),
    ]);
    if (!target.webhook) {
      const skipReason = admission?.emailAllowed === false
        ? admission.reason
        : recipientDecision.eligibleEmails.length === 0
          ? recipientDecision.skipped.suppressed > 0 && recipientDecision.skipped.unconfirmed === 0
            ? "notification_recipient_suppressed"
            : "notification_recipient_unconfirmed"
          : mailDeliverySkipReason(emailResults);
      if (skipReason) {
        return { disposition: "skipped", reason: skipReason };
      }
    }
    return { disposition: "delivered" };
  }

  /**
   * A hand-off and a completion notice share one delivery: the kind only picks the default text
   * (inside the formatter) and the `reason` the payload already carries. The email stays plain
   * text, so collected values reach it unescaped and never as markup. Replying to the email goes
   * to the address the notice's chosen field collected; the webhook names it as `replyTo`.
   */
  private routineEndingDelivery(
    notification: RoutineEndingOperatorNotification,
    context: OperatorNotificationContext,
    openLine: string[],
    links: { dashboardUrl: string | null; dashboardPath: string | null },
  ): { subject: string; text: string; replyTo: string | null; webhookPayload: Record<string, unknown> } {
    const formatted = formatRoutineEndingNotification(notification);
    const replyTo = notification.replyTo ?? null;
    return {
      subject: formatted.subject,
      text: [...formatted.lines, ...openLine].join("\n"),
      replyTo,
      webhookPayload: {
        workspaceId: notification.workspaceId,
        agentId: notification.agentId,
        conversationId: notification.conversationId,
        reason: notification.reason,
        routine: notification.routine ?? null,
        collected: notification.collected ?? {},
        subject: formatted.notice.subject,
        intro: formatted.notice.intro,
        replyTo,
        ...links,
        requestId: context.requestId,
      },
    };
  }

  private async postWebhook(input: {
    webhook: AgentContactWebhook;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    missingClientMessage: string;
  }): Promise<void> {
    if (!this.webhookClient) {
      throw new Error(input.missingClientMessage);
    }
    const rawBody = JSON.stringify(input.payload);
    await this.webhookClient.post({
      url: input.webhook.url,
      rawBody,
      headers: createSignedWebhookHeaders({ rawBody, secret: input.webhook.url, idempotencyKey: input.idempotencyKey }),
    });
  }
}
