import type { AgentContactWebhook } from "../../../agents/public.js";
import type { ActionHandler, ActionHandlerContext } from "./actionDispatcher.js";
import type {
  ContactNotificationMailer,
  ContactRecipientResolver,
  ContactWebhookHttpClient,
} from "./contactSendActionHandler.js";

/**
 * Out-of-band notification that a routine suspended at an approval gate and a human must
 * decide before it resumes. Reuses the contact-delivery transport (workspace recipients /
 * signed webhook) like `handoff.notify`; the worker dispatches it under the turn's
 * idempotency key so a redelivery never double-sends. The decision itself is resolved via
 * the authenticated decision endpoint — this only carries the operator there.
 */
export const APPROVAL_REQUEST_ACTION_TYPE = "approval.request";

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export class ApprovalRequestActionHandler implements ActionHandler {
  constructor(
    private readonly mailer: ContactNotificationMailer,
    private readonly recipients: ContactRecipientResolver,
    private readonly logger?: { warn(payload: Record<string, unknown>, message: string): void },
    private readonly webhookClient?: ContactWebhookHttpClient,
  ) {}

  async handle(input: { payload: Record<string, unknown>; context: ActionHandlerContext }): Promise<void> {
    const target = await this.recipients.resolve(input.context);
    if (target.emails.length === 0 && !target.webhook) {
      this.logger?.warn(
        { workspaceId: input.context.workspaceId, conversationId: input.context.conversationId },
        "approval.request: no recipient configured for workspace; skipping",
      );
      return;
    }

    const conversationId = asString(input.payload.conversationId) ?? input.context.conversationId ?? "unknown";
    const workspaceId = asString(input.payload.workspaceId) ?? input.context.workspaceId ?? "unknown";
    const agentId = asString(input.payload.agentId) ?? "unknown";
    const handle = asString(input.payload.handle) ?? "unknown";
    const dashboardPath = asString(input.payload.dashboardPath) ?? `/conversations/${conversationId}`;
    const baseIdempotencyKey = input.context.idempotencyKey ?? input.context.requestId;
    const text = [
      "A conversation is waiting for an approval decision.",
      "",
      `Conversation: ${conversationId}`,
      `Workspace: ${workspaceId}`,
      `Agent: ${agentId}`,
      `Decision: ${handle}`,
      `Open: ${dashboardPath}`,
    ].join("\n");

    await Promise.all([
      ...target.emails.map((to) =>
        this.mailer.send({
          to,
          subject: "Conversation needs an approval",
          text,
          idempotencyKey: `${baseIdempotencyKey}:email:${encodeURIComponent(to)}`,
        })),
      target.webhook ? this.postWebhook({
        webhook: target.webhook,
        payload: {
          workspaceId,
          agentId,
          conversationId,
          handle,
          dashboardPath,
          requestId: input.context.requestId,
        },
        idempotencyKey: `${baseIdempotencyKey}:webhook`,
      }) : Promise.resolve(),
    ]);
  }

  private async postWebhook(input: {
    webhook: AgentContactWebhook;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<void> {
    if (!this.webhookClient) {
      throw new Error("Approval request webhook delivery is not configured");
    }
    await this.webhookClient.post({
      url: input.webhook.url,
      rawBody: JSON.stringify(input.payload),
      headers: { "Idempotency-Key": input.idempotencyKey },
    });
  }
}
