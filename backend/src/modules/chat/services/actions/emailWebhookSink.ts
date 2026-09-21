import type { AgentContactWebhook } from "../../../agents/public.js";
import {
  resolveConversationLink,
  type ConversationLinkResolver,
  type OperatorNotification,
  type OperatorNotificationContext,
  type OperatorNotificationSink,
} from "../../../operatorNotifications/public.js";
import type {
  ContactNotificationMailer,
  ContactRecipientResolver,
  ContactWebhookHttpClient,
} from "./contactSendActionHandler.js";

/**
 * The webhook carried a relative `dashboardPath` before it carried the absolute `dashboardUrl`.
 * The path is kept for one release so a consumer prefixing its own origin keeps working — now
 * with a path the dashboard routes — and is `null` whenever the URL is.
 */
const deprecatedDashboardPath = (dashboardUrl: string | null): string | null => {
  if (!dashboardUrl) {
    return null;
  }
  const url = new URL(dashboardUrl);
  return `${url.pathname}${url.search}`;
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
    private readonly recipients: ContactRecipientResolver,
    private readonly logger?: { warn(payload: Record<string, unknown>, message: string): void },
    private readonly webhookClient?: ContactWebhookHttpClient,
    private readonly conversationLinks?: ConversationLinkResolver,
  ) {}

  async deliver(notification: OperatorNotification, context: OperatorNotificationContext): Promise<void> {
    const recipientContext = {
      requestId: context.requestId,
      workspaceId: context.workspaceId ?? notification.workspaceId,
      accountId: context.accountId ?? null,
      conversationId: context.conversationId ?? notification.conversationId,
      idempotencyKey: context.idempotencyKey ?? null,
      attempt: context.attempt ?? 1,
      // Handoff/approval notifications are emitted by a routine action step, not a
      // named skill invocation, so there is no firing skill to prefer here.
      skillName: null,
    };
    const target = await this.recipients.resolve(recipientContext);
    if (target.emails.length === 0 && !target.webhook) {
      const actionType = notification.kind === "approval" ? "approval.request" : "handoff.notify";
      this.logger?.warn(
        { workspaceId: context.workspaceId ?? notification.workspaceId, conversationId: context.conversationId ?? notification.conversationId },
        `${actionType}: no recipient configured for workspace; skipping`,
      );
      return;
    }

    const conversationUrl = await resolveConversationLink(
      this.conversationLinks,
      { workspaceId: notification.workspaceId, conversationId: notification.conversationId },
      this.logger,
    );
    const openLine = conversationUrl ? [`Open: ${conversationUrl}`] : [];
    const links = { dashboardUrl: conversationUrl, dashboardPath: deprecatedDashboardPath(conversationUrl) };

    const baseIdempotencyKey = context.idempotencyKey ?? context.requestId;
    const delivery = notification.kind === "approval"
      ? {
          subject: "Conversation needs an approval",
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
      : {
          subject: "Conversation needs a human",
          text: [
            "A conversation needs a human operator.",
            "",
            `Conversation: ${notification.conversationId}`,
            `Workspace: ${notification.workspaceId}`,
            `Agent: ${notification.agentId}`,
            `Reason: ${notification.reason}`,
            ...openLine,
          ].join("\n"),
          webhookPayload: {
            workspaceId: notification.workspaceId,
            agentId: notification.agentId,
            conversationId: notification.conversationId,
            reason: notification.reason,
            ...links,
            requestId: context.requestId,
          },
        };

    await Promise.all([
      ...target.emails.map((to) =>
        this.mailer.send({
          to,
          subject: delivery.subject,
          text: delivery.text,
          idempotencyKey: `${baseIdempotencyKey}:email:${encodeURIComponent(to)}`,
        })),
      target.webhook ? this.postWebhook({
        webhook: target.webhook,
        payload: delivery.webhookPayload,
        idempotencyKey: `${baseIdempotencyKey}:webhook`,
        missingClientMessage: notification.kind === "approval"
          ? "Approval request webhook delivery is not configured"
          : "Handoff webhook delivery is not configured",
      }) : Promise.resolve(),
    ]);
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
    await this.webhookClient.post({
      url: input.webhook.url,
      rawBody: JSON.stringify(input.payload),
      headers: { "Idempotency-Key": input.idempotencyKey },
    });
  }
}
