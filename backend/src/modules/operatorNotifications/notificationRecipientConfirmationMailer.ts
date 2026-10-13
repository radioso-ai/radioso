import type { EmailKind } from "../mail/public.js";
import type { NotificationRecipientTokenSigner } from "./notificationRecipientToken.js";

interface ConfirmationMailTransport {
  send(message: {
    to: string;
    kind: EmailKind;
    subject: string;
    text: string;
    idempotencyKey: string;
    listUnsubscribeUrl: string;
  }): Promise<{ dispatched: boolean }>;
}

interface ConfirmationObservability {
  logger?: { info(payload: Record<string, unknown>, message: string): void };
  metrics?: {
    incrementCounter(name: string, options: { help: string; labels?: Record<string, string>; value?: number }): void;
  } | null;
}

// Workspace and agent names are tenant-authored, so they are kept short enough that the
// confirmation request cannot carry a message of its own.
const NAME_MAX_LENGTH = 60;

const boundedName = (value: string): string => {
  const line = value.replace(/[\r\n]+/gu, " ").trim();
  return line.length > NAME_MAX_LENGTH ? `${line.slice(0, NAME_MAX_LENGTH - 1).trimEnd()}…` : line;
};

export class NotificationRecipientConfirmationMailer {
  private readonly baseUrl: URL;

  constructor(private readonly options: {
    mailer: ConfirmationMailTransport;
    signer: NotificationRecipientTokenSigner;
    publicBaseUrl: string;
  } & ConfirmationObservability) {
    this.baseUrl = new URL(options.publicBaseUrl);
  }

  async send(input: {
    workspaceId: string;
    workspaceName: string;
    agentName: string;
    email: string;
    recipientId: string;
    generation: number;
    idempotencyKey: string;
  }): Promise<{ dispatched: boolean }> {
    const confirmUrl = this.actionUrl("confirm", this.options.signer.sign(input.recipientId, "confirm", input.generation));
    const revokeUrl = this.revocationUrl(input.recipientId);
    const workspaceName = boundedName(input.workspaceName) || "A Radioso workspace";
    const agentName = boundedName(input.agentName) || "an agent";
    const result = await this.options.mailer.send({
      to: input.email,
      kind: "recipient_confirmation",
      subject: `${workspaceName} wants to send you ${agentName} notifications via Radioso`,
      text: [
        `${workspaceName} wants to send you ${agentName} notifications via Radioso.`,
        "",
        "Confirm this address:",
        confirmUrl,
        "",
        "If you do not want these notifications, you can stop them here:",
        revokeUrl,
      ].join("\n"),
      listUnsubscribeUrl: revokeUrl,
      // Each reservation signs a new generation, so a retry must not replay an earlier link.
      idempotencyKey: `notification-recipient-confirmation:${input.idempotencyKey}:${input.recipientId}:${input.generation}`,
    });
    if (!result.dispatched) return result;
    this.options.metrics?.incrementCounter("notification_recipient_confirmation_events_total", {
      help: "Notification recipient confirmation lifecycle events.",
      labels: { event: "sent" },
    });
    this.options.logger?.info({
      event: "notification_recipient_confirmation_sent",
      workspaceId: input.workspaceId,
    }, "Notification recipient confirmation sent");
    return result;
  }

  revocationUrl(recipientId: string): string {
    return this.actionUrl("revoke", this.options.signer.sign(recipientId, "revoke"));
  }

  private actionUrl(action: "confirm" | "revoke", token: string): string {
    const apiBase = this.baseUrl.toString().endsWith("/") ? this.baseUrl : new URL(`${this.baseUrl.toString()}/`);
    const url = new URL(`api/v1/notification-recipient-confirmations/${action}`, apiBase);
    url.searchParams.set("token", token);
    return url.toString();
  }
}
