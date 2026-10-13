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
  generation?: number | null;
}

/**
 * How often one workspace may ask strangers to confirm. The daily cap stops confirmation mail from
 * becoming the relay itself; the per-address spacing stops an operator from re-asking one inbox.
 */
export const NOTIFICATION_CONFIRMATION_LIMITS = {
  dailySends: 25,
  resendCooldownMs: 24 * 60 * 60 * 1000,
} as const;

interface NotificationRecipientStateStore {
  read(input: {
    workspaceId: string;
    emails: readonly string[];
    now: Date;
  }): Promise<NotificationRecipientStateView[]>;
  ensure(workspaceId: string, email: string): Promise<{ recipientId: string; generation: number }>;
  reserveConfirmationSend(input: {
    workspaceId: string;
    email: string;
    now: Date;
    force: boolean;
    limits: { dailySends: number; resendCooldownMs: number };
  }): Promise<{ recipientId: string; generation: number } | null>;
  releaseConfirmationSend(recipientId: string, generation: number, reservedAt: Date): Promise<void>;
  confirm(recipientId: string, generation: number, now: Date): Promise<boolean>;
  revoke(recipientId: string, now: Date): Promise<boolean>;
  resume(recipientId: string, now: Date): Promise<boolean>;
}

interface ConfirmationEmailRequest {
  workspaceId: string;
  workspaceName: string;
  agentName: string;
  email: string;
  idempotencyKey: string;
  recipientId?: string;
  generation?: number;
}

type ConfirmationEmailSender = (input: ConfirmationEmailRequest) => Promise<{ dispatched: boolean }>;

export interface NotificationRecipientPolicyPort {
  prepareDelivery(input: {
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
  }>;
  describe(workspaceId: string, emails: readonly string[]): Promise<NotificationRecipientDescription[]>;
  requestConfirmations(input: {
    workspaceId: string;
    agentId: string;
    emails: readonly string[];
    idempotencyKey: string;
  }): Promise<void>;
  resendConfirmation(input: {
    workspaceId: string;
    email: string;
    idempotencyKey: string;
    workspaceName?: string;
    agentName?: string;
    agentId?: string | null;
    conversationId?: string | null;
  }): Promise<boolean>;
  confirm(subject: { recipientId: string; generation: number }): Promise<boolean>;
  revoke(subject: { recipientId: string }): Promise<boolean>;
  resume(subject: { recipientId: string }): Promise<boolean>;
}

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

export class NotificationRecipientPolicyService implements NotificationRecipientPolicyPort {
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
        await this.requestConfirmation(input, recipient.email, false);
      }
    }

    this.recordSkipped(input.workspaceId, "unconfirmed", unconfirmed);
    this.recordSkipped(input.workspaceId, "suppressed", suppressed);
    return { eligibleEmails, eligibleRecipients, skipped: { unconfirmed, suppressed } };
  }

  /** Asks newly configured addresses to confirm before any notice is due, so the first one is not lost. */
  async requestConfirmations(input: {
    workspaceId: string;
    agentId: string;
    emails: readonly string[];
    idempotencyKey: string;
  }): Promise<void> {
    if (!this.options.enabled) return;
    // A settings save never fails on this: an address that misses it is asked at its first notice.
    let recipients: NotificationRecipientDescription[];
    try {
      recipients = await this.describe(input.workspaceId, input.emails);
    } catch {
      this.recordConfirmationFailure(input.workspaceId);
      return;
    }
    for (const recipient of recipients) {
      if (recipient.state === "waiting_for_confirmation" || recipient.state === "grandfathered") {
        await this.requestConfirmation(input, recipient.email, false);
      }
    }
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

  async confirm(subject: { recipientId: string; generation: number }): Promise<boolean> {
    const confirmed = await this.options.states.confirm(subject.recipientId, subject.generation, this.options.now?.() ?? new Date());
    if (confirmed) this.recordLifecycle("confirmed");
    return confirmed;
  }

  async revoke(subject: { recipientId: string }): Promise<boolean> {
    const revoked = await this.options.states.revoke(subject.recipientId, this.options.now?.() ?? new Date());
    if (revoked) this.recordLifecycle("revoked");
    return revoked;
  }

  async resume(subject: { recipientId: string }): Promise<boolean> {
    const resumed = await this.options.states.resume(subject.recipientId, this.options.now?.() ?? new Date());
    if (resumed) this.recordLifecycle("resumed");
    return resumed;
  }

  private async sendConfirmationWhenReserved(input: ConfirmationEmailRequest, force: boolean): Promise<boolean> {
    const now = this.options.now?.() ?? new Date();
    let reservation: { recipientId: string; generation: number } | null;
    try {
      reservation = await this.options.states.reserveConfirmationSend({
        workspaceId: input.workspaceId,
        email: input.email,
        now,
        force,
        limits: NOTIFICATION_CONFIRMATION_LIMITS,
      });
    } catch {
      this.recordConfirmationFailure(input.workspaceId);
      return false;
    }
    if (!reservation) return false;
    try {
      const result = await this.options.sendConfirmation({ ...input, recipientId: reservation.recipientId, generation: reservation.generation });
      if (!result.dispatched) {
        await this.releaseConfirmationReservation(input.workspaceId, reservation, now);
        return false;
      }
    } catch {
      await this.releaseConfirmationReservation(input.workspaceId, reservation, now);
      return false;
    }
    return true;
  }

  private async releaseConfirmationReservation(
    workspaceId: string,
    reservation: { recipientId: string; generation: number },
    reservedAt: Date,
  ): Promise<void> {
    await this.options.states.releaseConfirmationSend(reservation.recipientId, reservation.generation, reservedAt).catch(() => undefined);
    this.recordConfirmationFailure(workspaceId);
  }

  private recordConfirmationFailure(workspaceId: string): void {
    this.options.metrics?.incrementCounter("notification_recipient_confirmation_events_total", {
      help: "Notification recipient confirmation lifecycle events.",
      labels: { event: "send_failed" },
    });
    this.options.logger?.info({
      event: "notification_recipient_confirmation_send_failed",
      workspaceId,
    }, "Notification recipient confirmation send failed");
  }

  private async requestConfirmation(
    input: {
      workspaceId: string;
      workspaceName?: string;
      agentName?: string;
      agentId?: string | null;
      conversationId?: string | null;
      idempotencyKey: string;
    },
    email: string,
    force: boolean,
  ): Promise<void> {
    try {
      const identity = await this.identityFor(input);
      await this.sendConfirmationWhenReserved({
        workspaceId: input.workspaceId,
        workspaceName: identity.workspaceName,
        agentName: identity.agentName,
        email,
        idempotencyKey: input.idempotencyKey,
      }, force);
    } catch {
      this.recordConfirmationFailure(input.workspaceId);
    }
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

  private recordLifecycle(event: "confirmed" | "revoked" | "resumed"): void {
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
