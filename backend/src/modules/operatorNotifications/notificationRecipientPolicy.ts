import { normalizeRecipientEmail } from "../../shared/domain/recipientEmailAudit.js";

type NotificationRecipientState =
  | "confirmed"
  | "grandfathered"
  | "waiting_for_confirmation"
  | "revoked"
  | "suppressed"
  | "confirmation_not_required";

type StoredNotificationRecipientState = Exclude<NotificationRecipientState, "confirmation_not_required">;

export interface NotificationRecipientStateView {
  email: string;
  state: StoredNotificationRecipientState;
  grandfatheredUntil: Date | null;
  /** When this address was last sent a confirmation link, if ever. */
  confirmationSentAt: Date | null;
  recipientId?: string | null;
  generation?: number | null;
}

/**
 * How often strangers may be asked to confirm. The workspace and account caps stop confirmation mail
 * from becoming the relay itself, and an account cannot multiply its allowance by adding
 * workspaces; the per-address spacing stops an operator from re-asking one inbox.
 */
export const NOTIFICATION_CONFIRMATION_LIMITS = {
  dailySends: 25,
  accountDailySends: 50,
  resendCooldownMs: 24 * 60 * 60 * 1000,
} as const;

/**
 * An address configured before confirmation existed keeps receiving notices until it confirms or until
 * both its recorded deadline and this long after its confirmation link have passed, so no address
 * is cut off before it was asked.
 */
const GRANDFATHERED_ANSWER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface ConfirmationReservation {
  recipientId: string;
  generation: number;
  reservedAt: Date;
  previousSentAt: Date | null;
}

export interface NotificationRecipientStateStore {
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
    limits: { dailySends: number; accountDailySends: number; resendCooldownMs: number };
  }): Promise<ConfirmationReservation | null>;
  releaseConfirmationSend(reservation: ConfirmationReservation, outcome: "not_dispatched" | "failed"): Promise<void>;
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

interface RecipientIdentity {
  workspaceName: string;
  agentName: string;
}

interface ConfirmationRequestContext {
  workspaceId: string;
  workspaceName?: string;
  agentName?: string;
  agentId?: string | null;
  conversationId?: string | null;
  idempotencyKey: string;
}

export interface NotificationRecipientPolicyPort {
  prepareDelivery(input: ConfirmationRequestContext & { emails: readonly string[] }): Promise<{
    eligibleEmails: string[];
    eligibleRecipients: Array<{ email: string; listUnsubscribeUrl: string }>;
    skipped: { unconfirmed: number; suppressed: number; revoked: number };
  }>;
  describe(workspaceId: string, emails: readonly string[]): Promise<NotificationRecipientDescription[]>;
  requestConfirmations(input: {
    workspaceId: string;
    agentId: string;
    emails: readonly string[];
    idempotencyKey: string;
  }): Promise<void>;
  resendConfirmation(input: ConfirmationRequestContext & { email: string }): Promise<boolean>;
  confirm(subject: { recipientId: string; generation: number }): Promise<boolean>;
  revoke(subject: { recipientId: string }): Promise<boolean>;
  resume(subject: { recipientId: string }): Promise<boolean>;
}

export interface NotificationRecipientDescription {
  email: string;
  state: NotificationRecipientState;
}

interface EffectiveRecipient extends NotificationRecipientDescription {
  recipientId: string | null;
  /** A confirmation link already went out, so a notice does not ask again; an operator resend can. */
  alreadyAsked: boolean;
}

const uniqueNormalizedEmails = (emails: readonly string[]): string[] =>
  [...new Set(emails.map(normalizeRecipientEmail).filter(Boolean))];

const effectiveState = (view: NotificationRecipientStateView, now: Date): StoredNotificationRecipientState => {
  if (view.state !== "grandfathered") return view.state;
  const answerDeadline = view.confirmationSentAt
    ? view.confirmationSentAt.getTime() + GRANDFATHERED_ANSWER_WINDOW_MS
    : Number.POSITIVE_INFINITY;
  const deadline = Math.max(view.grandfatheredUntil?.getTime() ?? 0, answerDeadline);
  return deadline > now.getTime() ? "grandfathered" : "waiting_for_confirmation";
};

const awaitingConfirmation = (state: NotificationRecipientState): boolean =>
  state === "grandfathered" || state === "waiting_for_confirmation";

const deliverable = (state: NotificationRecipientState): boolean =>
  state === "confirmed" || state === "grandfathered" || state === "confirmation_not_required";

/** Resolves the names a confirmation shows at most once per call, and only when one is sent. */
const lazyIdentity = (resolve: () => Promise<RecipientIdentity>): (() => Promise<RecipientIdentity>) => {
  let pending: Promise<RecipientIdentity> | null = null;
  return () => {
    pending ??= resolve();
    return pending;
  };
};

export class NotificationRecipientPolicyService implements NotificationRecipientPolicyPort {
  constructor(private readonly options: {
    enabled: boolean;
    states: NotificationRecipientStateStore;
    sendConfirmation: ConfirmationEmailSender;
    revocationUrl?: (recipientId: string) => string;
    identity?: {
      resolve(input: { workspaceId: string; agentId?: string | null; conversationId?: string | null }): Promise<RecipientIdentity>;
    };
    now?: () => Date;
    logger?: { info(payload: Record<string, unknown>, message: string): void };
    metrics?: {
      incrementCounter(name: string, options: { help: string; labels?: Record<string, string>; value?: number }): void;
    } | null;
  }) {}

  async describe(workspaceId: string, emails: readonly string[]): Promise<NotificationRecipientDescription[]> {
    const recipients = await this.effectiveRecipients(workspaceId, emails);
    return recipients.map(({ email, state }) => ({ email, state }));
  }

  async prepareDelivery(input: ConfirmationRequestContext & { emails: readonly string[] }): Promise<{
    eligibleEmails: string[];
    eligibleRecipients: Array<{ email: string; listUnsubscribeUrl: string }>;
    skipped: { unconfirmed: number; suppressed: number; revoked: number };
  }> {
    const recipients = await this.effectiveRecipients(input.workspaceId, input.emails);
    const identity = lazyIdentity(() => this.identityFor(input));
    const eligibleRecipients: Array<{ email: string; listUnsubscribeUrl: string }> = [];
    const skipped = { unconfirmed: 0, suppressed: 0, revoked: 0 };

    for (const recipient of recipients) {
      if (deliverable(recipient.state)) {
        const recipientId = recipient.recipientId
          ?? (await this.options.states.ensure(input.workspaceId, recipient.email)).recipientId;
        eligibleRecipients.push({
          email: recipient.email,
          listUnsubscribeUrl: this.options.revocationUrl?.(recipientId) ?? "",
        });
      } else if (recipient.state === "suppressed") {
        skipped.suppressed += 1;
      } else if (recipient.state === "revoked") {
        skipped.revoked += 1;
      } else {
        skipped.unconfirmed += 1;
      }

      if (this.options.enabled && awaitingConfirmation(recipient.state) && !recipient.alreadyAsked) {
        await this.requestConfirmation(input, recipient.email, false, identity);
      }
    }

    this.recordSkipped(input.workspaceId, skipped);
    return {
      eligibleEmails: eligibleRecipients.map((recipient) => recipient.email),
      eligibleRecipients,
      skipped,
    };
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
    let recipients: EffectiveRecipient[];
    try {
      recipients = await this.effectiveRecipients(input.workspaceId, input.emails);
    } catch {
      this.recordConfirmationFailure(input.workspaceId);
      return;
    }
    const identity = lazyIdentity(() => this.identityFor(input));
    for (const recipient of recipients) {
      if (awaitingConfirmation(recipient.state) && !recipient.alreadyAsked) {
        await this.requestConfirmation(input, recipient.email, false, identity);
      }
    }
  }

  async resendConfirmation(input: ConfirmationRequestContext & { email: string }): Promise<boolean> {
    if (!this.options.enabled) return false;
    return this.sendConfirmationWhenReserved(input, input.email, true, lazyIdentity(() => this.identityFor(input)));
  }

  async confirm(subject: { recipientId: string; generation: number }): Promise<boolean> {
    const confirmed = await this.options.states.confirm(subject.recipientId, subject.generation, this.now());
    if (confirmed) this.recordLifecycle("confirmed");
    return confirmed;
  }

  async revoke(subject: { recipientId: string }): Promise<boolean> {
    const revoked = await this.options.states.revoke(subject.recipientId, this.now());
    if (revoked) this.recordLifecycle("revoked");
    return revoked;
  }

  async resume(subject: { recipientId: string }): Promise<boolean> {
    const resumed = await this.options.states.resume(subject.recipientId, this.now());
    if (resumed) this.recordLifecycle("resumed");
    return resumed;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async effectiveRecipients(workspaceId: string, emails: readonly string[]): Promise<EffectiveRecipient[]> {
    const normalized = uniqueNormalizedEmails(emails);
    const now = this.now();
    const stored = await this.options.states.read({ workspaceId, emails: normalized, now });
    const byEmail = new Map(stored.map((view) => [view.email, view]));
    return normalized.map((email) => {
      const view = byEmail.get(email);
      const state = view ? effectiveState(view, now) : "waiting_for_confirmation";
      return {
        email,
        recipientId: view?.recipientId ?? null,
        alreadyAsked: Boolean(view?.confirmationSentAt),
        state: !this.options.enabled && state !== "suppressed" && state !== "revoked"
          ? "confirmation_not_required"
          : state,
      };
    });
  }

  private async requestConfirmation(
    context: ConfirmationRequestContext,
    email: string,
    force: boolean,
    identity: () => Promise<RecipientIdentity>,
  ): Promise<void> {
    try {
      await this.sendConfirmationWhenReserved(context, email, force, identity);
    } catch {
      this.recordConfirmationFailure(context.workspaceId);
    }
  }

  private async sendConfirmationWhenReserved(
    context: ConfirmationRequestContext,
    email: string,
    force: boolean,
    identity: () => Promise<RecipientIdentity>,
  ): Promise<boolean> {
    let reservation: ConfirmationReservation | null;
    try {
      reservation = await this.options.states.reserveConfirmationSend({
        workspaceId: context.workspaceId,
        email,
        now: this.now(),
        force,
        limits: NOTIFICATION_CONFIRMATION_LIMITS,
      });
    } catch {
      this.recordConfirmationFailure(context.workspaceId);
      return false;
    }
    if (!reservation) return false;

    let names: RecipientIdentity;
    try {
      names = await identity();
    } catch {
      await this.releaseConfirmationReservation(context.workspaceId, reservation, "not_dispatched");
      return false;
    }
    try {
      const result = await this.options.sendConfirmation({
        workspaceId: context.workspaceId,
        workspaceName: names.workspaceName,
        agentName: names.agentName,
        email,
        idempotencyKey: context.idempotencyKey,
        recipientId: reservation.recipientId,
        generation: reservation.generation,
      });
      if (!result.dispatched) {
        await this.releaseConfirmationReservation(context.workspaceId, reservation, "not_dispatched");
        return false;
      }
    } catch {
      await this.releaseConfirmationReservation(context.workspaceId, reservation, "failed");
      return false;
    }
    return true;
  }

  private async releaseConfirmationReservation(
    workspaceId: string,
    reservation: ConfirmationReservation,
    outcome: "not_dispatched" | "failed",
  ): Promise<void> {
    await this.options.states.releaseConfirmationSend(reservation, outcome).catch(() => undefined);
    this.recordConfirmationFailure(workspaceId);
  }

  private async identityFor(input: {
    workspaceId: string;
    workspaceName?: string;
    agentName?: string;
    agentId?: string | null;
    conversationId?: string | null;
  }): Promise<RecipientIdentity> {
    if (input.workspaceName && input.agentName) {
      return { workspaceName: input.workspaceName, agentName: input.agentName };
    }
    if (this.options.identity) {
      return this.options.identity.resolve(input);
    }
    return { workspaceName: input.workspaceName ?? "Your workspace", agentName: input.agentName ?? "your agent" };
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

  private recordLifecycle(event: "confirmed" | "revoked" | "resumed"): void {
    this.options.metrics?.incrementCounter("notification_recipient_confirmation_events_total", {
      help: "Notification recipient confirmation lifecycle events.",
      labels: { event },
    });
    this.options.logger?.info({ event: `notification_recipient_${event}` }, `Notification recipient ${event}`);
  }

  private recordSkipped(workspaceId: string, skipped: { unconfirmed: number; suppressed: number; revoked: number }): void {
    for (const [reason, count] of Object.entries(skipped)) {
      if (count === 0) continue;
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
}
