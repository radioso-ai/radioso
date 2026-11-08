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
   * about it within the last day. Resolves without error when nothing is sent. Once `signal`
   * aborts the caller has stopped waiting: the alert finishes quietly, recording no outcome, so one
   * alert never has two.
   */
  notify(input: {
    workspaceId: string;
    agentId: string | null;
    email: string;
    reason: UndeliveredRecipientReason;
  }, options?: { signal?: AbortSignal }): Promise<void>;
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
  }, options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    // A caller that stopped waiting has already recorded its own outcome for this alert.
    const abandoned = (): boolean => signal?.aborted === true;
    let claim: UndeliveredAlertClaim | null = null;
    try {
      claim = await this.options.store.claim({
        workspaceId: input.workspaceId,
        email: input.email,
        now: this.options.now?.() ?? new Date(),
        windowMs: UNDELIVERED_ALERT_WINDOW_MS,
      });
      if (!claim) return;
      const result = await this.sendToAdministrators(input, claim, signal);
      // Nobody to tell, or every send failed: nothing was said, so a later notice may try again.
      // A transport that reports dispatching nothing will say nothing on any retry, so it keeps the claim.
      const anyoneTold = result.dispatched > 0;
      const keepClaim = anyoneTold || (result.administrators > 0 && result.rejected === 0);
      if (!keepClaim) await this.options.store.release(claim);
      if (abandoned()) return;
      if (result.rejected > 0) {
        this.count("failed", input.reason);
        this.options.logger?.warn({
          event: "notification_undelivered_alert_failed",
          workspaceId: input.workspaceId,
          reason: input.reason,
          errorName: result.firstFailure instanceof Error ? result.firstFailure.name : "unknown",
          failedCount: result.rejected,
          administratorCount: result.administrators,
        }, "Undelivered recipient alert failed");
        return;
      }
      if (!anyoneTold) {
        this.count("not_sent", input.reason);
        return;
      }
      this.count("sent", input.reason);
      this.options.logger?.info({
        event: "notification_undelivered_alert_sent",
        workspaceId: input.workspaceId,
        reason: input.reason,
        administratorCount: result.dispatched,
      }, "Undelivered recipient alert sent");
    } catch (error) {
      if (claim) await this.options.store.release(claim).catch(() => undefined);
      if (abandoned()) return;
      this.count("failed", input.reason);
      this.options.logger?.warn({
        event: "notification_undelivered_alert_failed",
        workspaceId: input.workspaceId,
        reason: input.reason,
        errorName: error instanceof Error ? error.name : "unknown",
      }, "Undelivered recipient alert failed");
    }
  }

  private async sendToAdministrators(
    input: { workspaceId: string; agentId: string | null; email: string; reason: UndeliveredRecipientReason },
    claim: UndeliveredAlertClaim,
    signal: AbortSignal | undefined,
  ): Promise<{ administrators: number; dispatched: number; rejected: number; firstFailure: unknown }> {
    const nothingSent = (administrators: number) => ({ administrators, dispatched: 0, rejected: 0, firstFailure: undefined });
    const administrators = await this.options.store.listAdministratorEmails(input.workspaceId);
    if (administrators.length === 0 || signal?.aborted) return nothingSent(0);
    const [names, dashboardUrl] = await Promise.all([
      this.options.identity.resolve(input),
      this.options.dashboardUrl(input).catch(() => null),
    ]);
    // Past this point mail goes out; before it, an abandoned alert has told no one and can stop.
    if (signal?.aborted) return nothingSent(0);
    const message = undeliveredRecipientAlertMessage({ ...input, ...names, dashboardUrl });
    const results = await Promise.allSettled(administrators.map((to) => this.options.mailer.send({
      to,
      kind: "notification_alert",
      subject: message.subject,
      text: message.text,
      idempotencyKey: `notification-undelivered-alert:${claim.recipientId}:${claim.claimedAt.toISOString()}:${to}`,
    })));
    const rejections = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    return {
      administrators: administrators.length,
      dispatched: results.filter((result) => result.status === "fulfilled" && result.value.dispatched).length,
      rejected: rejections.length,
      firstFailure: rejections[0]?.reason,
    };
  }

  private count(outcome: "sent" | "not_sent" | "failed", reason: UndeliveredRecipientReason): void {
    this.options.metrics?.incrementCounter("notification_undelivered_alerts_total", {
      help: "Alerts to workspace administrators about an address that notices skip.",
      labels: { outcome, reason },
    });
  }
}
