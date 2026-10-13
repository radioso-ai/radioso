type NotificationRecipientState =
  | "confirmed"
  | "grandfathered"
  | "waiting_for_confirmation"
  | "revoked"
  | "suppressed"
  | "confirmation_not_required";

type StoredNotificationRecipientState = Exclude<NotificationRecipientState, "confirmation_not_required">;

interface NotificationRecipientStateView {
  email: string;
  state: StoredNotificationRecipientState;
  grandfatheredUntil: Date | null;
  recipientId?: string | null;
}

interface NotificationRecipientStateStore {
  read(input: {
    workspaceId: string;
    emails: readonly string[];
    now: Date;
  }): Promise<NotificationRecipientStateView[]>;
  ensure(workspaceId: string, email: string): Promise<{ recipientId: string }>;
  reserveConfirmationSend(input: {
    workspaceId: string;
    email: string;
    now: Date;
    force: boolean;
  }): Promise<{ recipientId: string } | null>;
  releaseConfirmationSend(recipientId: string, reservedAt: Date): Promise<void>;
  confirm(recipientId: string, now: Date): Promise<void>;
  revoke(recipientId: string, now: Date): Promise<void>;
}

interface ConfirmationEmailRequest {
  workspaceId: string;
  workspaceName: string;
  agentName: string;
  email: string;
  idempotencyKey: string;
  recipientId?: string;
}

type ConfirmationEmailSender = (input: ConfirmationEmailRequest) => Promise<void>;

export interface NotificationRecipientDescription {
  email: string;
  state: NotificationRecipientState;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const uniqueNormalizedEmails = (emails: readonly string[]): string[] =>
  [...new Set(emails.map(normalizeEmail).filter(Boolean))];

const effectiveState = (view: NotificationRecipientStateView, now: Date): StoredNotificationRecipientState =>
  view.state === "grandfathered"
    && view.grandfatheredUntil !== null
    && view.grandfatheredUntil.getTime() <= now.getTime()
    ? "waiting_for_confirmation"
    : view.state;

export class NotificationRecipientPolicyService {
  constructor(private readonly options: {
    enabled: boolean;
    states: NotificationRecipientStateStore;
    sendConfirmation: ConfirmationEmailSender;
    revocationUrl?: (recipientId: string) => string;
    identity?: {
      resolve(input: { workspaceId: string; agentId?: string | null; conversationId?: string | null }): Promise<{
        workspaceName: string;
        agentName: string;
      }>;
    };
    now?: () => Date;
    logger?: { info(payload: Record<string, unknown>, message: string): void };
    metrics?: {
      incrementCounter(name: string, options: { help: string; labels?: Record<string, string>; value?: number }): void;
    } | null;
  }) {}

  async describe(workspaceId: string, emails: readonly string[]): Promise<NotificationRecipientDescription[]> {
    const normalized = uniqueNormalizedEmails(emails);
    const now = this.options.now?.() ?? new Date();
    const stored = await this.options.states.read({ workspaceId, emails: normalized, now });
    const byEmail = new Map(stored.map((view) => [view.email, effectiveState(view, now)]));
    return normalized.map((email) => {
      const state = byEmail.get(email) ?? "waiting_for_confirmation";
      return {
        email,
        state: !this.options.enabled && state !== "suppressed" && state !== "revoked"
          ? "confirmation_not_required"
          : state,
      };
    });
  }

  async prepareDelivery(input: {
    workspaceId: string;
    workspaceName?: string;
    agentName?: string;
    agentId?: string | null;
    conversationId?: string | null;
    emails: readonly string[];
    idempotencyKey: string;
  }): Promise<{
    eligibleEmails: string[];
    eligibleRecipients: Array<{ email: string; listUnsubscribeUrl: string }>;
    skipped: { unconfirmed: number; suppressed: number };
  }> {
    const recipients = await this.describe(input.workspaceId, input.emails);
    const eligibleEmails: string[] = [];
    const eligibleRecipients: Array<{ email: string; listUnsubscribeUrl: string }> = [];
    let unconfirmed = 0;
    let suppressed = 0;

    for (const recipient of recipients) {
      if (recipient.state === "suppressed") {
        suppressed += 1;
        continue;
      }
      if (recipient.state === "confirmed"
        || recipient.state === "grandfathered"
        || recipient.state === "confirmation_not_required") {
        eligibleEmails.push(recipient.email);
        const ensured = await this.options.states.ensure(input.workspaceId, recipient.email);
        eligibleRecipients.push({
          email: recipient.email,
          listUnsubscribeUrl: this.options.revocationUrl?.(ensured.recipientId) ?? "",
        });
      } else {
        unconfirmed += 1;
      }

      if (this.options.enabled
        && (recipient.state === "grandfathered" || recipient.state === "waiting_for_confirmation")) {
        const identity = await this.identityFor(input);
        await this.sendConfirmationWhenReserved({
          workspaceId: input.workspaceId,
          workspaceName: identity.workspaceName,
          agentName: identity.agentName,
          email: recipient.email,
          idempotencyKey: input.idempotencyKey,
        }, false);
      }
    }

    this.recordSkipped(input.workspaceId, "unconfirmed", unconfirmed);
    this.recordSkipped(input.workspaceId, "suppressed", suppressed);
    return { eligibleEmails, eligibleRecipients, skipped: { unconfirmed, suppressed } };
  }

  async resendConfirmation(input: {
    workspaceId: string;
    email: string;
    idempotencyKey: string;
    workspaceName?: string;
    agentName?: string;
    agentId?: string | null;
    conversationId?: string | null;
  }): Promise<boolean> {
    if (!this.options.enabled) return false;
    const identity = await this.identityFor(input);
    return this.sendConfirmationWhenReserved({ ...input, ...identity }, true);
  }

  async confirm(recipientId: string): Promise<void> {
    await this.options.states.confirm(recipientId, this.options.now?.() ?? new Date());
    this.recordLifecycle("confirmed");
  }

  async revoke(recipientId: string): Promise<void> {
    await this.options.states.revoke(recipientId, this.options.now?.() ?? new Date());
    this.recordLifecycle("revoked");
  }

  private async sendConfirmationWhenReserved(input: ConfirmationEmailRequest, force: boolean): Promise<boolean> {
    const now = this.options.now?.() ?? new Date();
    const reservation = await this.options.states.reserveConfirmationSend({
      workspaceId: input.workspaceId,
      email: input.email,
      now,
      force,
    });
    if (!reservation) return false;
    try {
      await this.options.sendConfirmation({ ...input, recipientId: reservation.recipientId });
    } catch (error) {
      await this.options.states.releaseConfirmationSend(reservation.recipientId, now).catch(() => undefined);
      this.options.metrics?.incrementCounter("notification_recipient_confirmation_events_total", {
        help: "Notification recipient confirmation lifecycle events.",
        labels: { event: "send_failed" },
      });
      this.options.logger?.info({
        event: "notification_recipient_confirmation_send_failed",
        workspaceId: input.workspaceId,
      }, "Notification recipient confirmation send failed");
      throw error;
    }
    return true;
  }

  private async identityFor(input: {
    workspaceId: string;
    workspaceName?: string;
    agentName?: string;
    agentId?: string | null;
    conversationId?: string | null;
  }): Promise<{ workspaceName: string; agentName: string }> {
    if (input.workspaceName && input.agentName) {
      return { workspaceName: input.workspaceName, agentName: input.agentName };
    }
    if (this.options.identity) {
      return this.options.identity.resolve(input);
    }
    return { workspaceName: input.workspaceName ?? "Your workspace", agentName: input.agentName ?? "your agent" };
  }

  private recordLifecycle(event: "confirmed" | "revoked"): void {
    this.options.metrics?.incrementCounter("notification_recipient_confirmation_events_total", {
      help: "Notification recipient confirmation lifecycle events.",
      labels: { event },
    });
    this.options.logger?.info({ event: `notification_recipient_${event}` }, `Notification recipient ${event}`);
  }

  private recordSkipped(workspaceId: string, reason: "unconfirmed" | "suppressed", count: number): void {
    if (count === 0) return;
    this.options.metrics?.incrementCounter("notification_recipient_delivery_skipped_total", {
      help: "Notification recipients skipped by confirmation and suppression policy.",
      labels: { reason },
      value: count,
    });
    this.options.logger?.info({
      event: "notification_recipient_delivery_skipped",
      workspaceId,
      reason,
      recipientCount: count,
    }, "Notification recipient delivery skipped");
  }
}
