import type { EmailKind } from "../mail/public.js";
import {
  undeliveredRecipientAlertMessage,
  type UndeliveredRecipientReason,
} from "./undeliveredRecipientAlertText.js";

export type { UndeliveredRecipientReason } from "./undeliveredRecipientAlertText.js";

/** An address is alerted about at most once in this long. */
export const UNDELIVERED_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface UndeliveredRecipientAlertPort {
  /**
   * Tells the workspace's administrators a notice skipped this address, unless they were told
   * about it within the last day. Resolves without error when nothing is sent.
   */
  notify(input: {
    workspaceId: string;
    agentId: string | null;
    email: string;
    reason: UndeliveredRecipientReason;
  }): Promise<void>;
}

export interface UndeliveredAlertClaim {
  recipientId: string;
  claimedAt: Date;
}

export interface UndeliveredRecipientAlertStore {
  /**
   * Takes the right to alert about this address, atomically: one caller gets a claim and every
   * other gets null until the window has passed.
   */
  claim(input: { workspaceId: string; email: string; now: Date; windowMs: number }): Promise<UndeliveredAlertClaim | null>;
  /** Gives the claim back because nothing was sent, so the next skipped notice can alert. */
  release(claim: UndeliveredAlertClaim): Promise<void>;
  /** Active, enabled, verified owners and admins of the account the workspace belongs to. */
  listAdministratorEmails(workspaceId: string): Promise<string[]>;
}

interface AlertMailTransport {
  send(message: {
    to: string;
    kind: EmailKind;
    subject: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ dispatched: boolean }>;
}

interface AlertMetrics {
  incrementCounter(name: string, options: { help: string; labels?: Record<string, string>; value?: number }): void;
}

/**
 * Emails an account's owners and admins when notices stop reaching an address they rely on. The
 * address and the agent are in the mail; neither is in a log line or a metric label. A failure
 * never rejects: the notice that raised the alert has already been decided.
 */
export class UndeliveredRecipientAlerts implements UndeliveredRecipientAlertPort {
  constructor(private readonly options: {
    store: UndeliveredRecipientAlertStore;
    mailer: AlertMailTransport;
    identity: { resolve(input: { workspaceId: string; agentId: string | null }): Promise<{ workspaceName: string; agentName: string }> };
    /** The dashboard page where the agent's notifications are fixed, when the deployment has one. */
    dashboardUrl: (input: { workspaceId: string; agentId: string | null }) => Promise<string | null>;
    logger?: { info(payload: Record<string, unknown>, message: string): void; warn(payload: Record<string, unknown>, message: string): void };
    metrics?: AlertMetrics | null;
    now?: () => Date;
  }) {}

  async notify(input: {
    workspaceId: string;
    agentId: string | null;
    email: string;
    reason: UndeliveredRecipientReason;
  }): Promise<void> {
    let claim: UndeliveredAlertClaim | null = null;
    try {
      claim = await this.options.store.claim({
        workspaceId: input.workspaceId,
        email: input.email,
        now: this.options.now?.() ?? new Date(),
        windowMs: UNDELIVERED_ALERT_WINDOW_MS,
      });
      if (!claim) return;
      const sent = await this.sendToAdministrators(input, claim);
      if (sent === 0) {
        await this.options.store.release(claim);
        this.count("not_sent", input.reason);
        return;
      }
      this.count("sent", input.reason);
      this.options.logger?.info({
        event: "notification_undelivered_alert_sent",
        workspaceId: input.workspaceId,
        reason: input.reason,
        administratorCount: sent,
      }, "Undelivered recipient alert sent");
    } catch (error) {
      this.count("failed", input.reason);
      this.options.logger?.warn({
        event: "notification_undelivered_alert_failed",
        workspaceId: input.workspaceId,
        reason: input.reason,
        errorName: error instanceof Error ? error.name : "unknown",
      }, "Undelivered recipient alert failed");
      if (claim) await this.options.store.release(claim).catch(() => undefined);
    }
  }

  private async sendToAdministrators(
    input: { workspaceId: string; agentId: string | null; email: string; reason: UndeliveredRecipientReason },
    claim: UndeliveredAlertClaim,
  ): Promise<number> {
    const administrators = await this.options.store.listAdministratorEmails(input.workspaceId);
    if (administrators.length === 0) return 0;
    const [names, dashboardUrl] = await Promise.all([
      this.options.identity.resolve(input),
      this.options.dashboardUrl(input).catch(() => null),
    ]);
    const message = undeliveredRecipientAlertMessage({ ...input, ...names, dashboardUrl });
    const results = await Promise.allSettled(administrators.map((to) => this.options.mailer.send({
      to,
      kind: "notification_alert",
      subject: message.subject,
      text: message.text,
      idempotencyKey: `notification-undelivered-alert:${claim.recipientId}:${claim.claimedAt.toISOString()}:${to}`,
    })));
    return results.filter((result) => result.status === "fulfilled" && result.value.dispatched).length;
  }

  private count(outcome: "sent" | "not_sent" | "failed", reason: UndeliveredRecipientReason): void {
    this.options.metrics?.incrementCounter("notification_undelivered_alerts_total", {
      help: "Alerts to workspace administrators about an address that notices skip.",
      labels: { outcome, reason },
    });
  }
}
