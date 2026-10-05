import { EmailLookupError, type EmailDriver } from "../../mail/public.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { EmailChannelLogger } from "../emailChannelAudit.js";
import type { EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";
import type { EmailSendIntentRecord, EmailSendIntentRepository } from "../persistence/emailSendIntentRepository.js";
import { EmailSendRetryableError, type ProviderSendAttempt } from "./providerSendAttempt.js";
import { ownershipFactsOf, repostAuthorized, type EmailSendOwnershipReader } from "./sendAuthority.js";
import type { SendIntentWriter } from "./sendIntentWriter.js";

/**
 * How long a claim keeps other sweeps off an intent. A claim that ends without a transition (the
 * provider asked to be asked again, or the lookup failed) is picked up again once it runs out.
 */
const DEFAULT_LEASE_SECONDS = 300;

/** What one claimed intent came to. */
type ReconcileResult = "reposted" | "settled" | "uncertain" | "deferred" | "skipped";

interface SendReconcileRun {
  claimed: number;
  reposted: number;
  settled: number;
  uncertain: number;
  deferred: number;
  skipped: number;
  errored: number;
}

const emptyRun = (): SendReconcileRun => ({ claimed: 0, reposted: 0, settled: 0, uncertain: 0, deferred: 0, skipped: 0, errored: 0 });

/**
 * Settles the sends no provider event has settled (research B6, B18). It claims due intents with
 * `reconcile_lease_until`, so two sweeps never work the same one, and for each:
 *
 * - a send whose outcome was unknown is re-POSTed with its key and frozen request while the
 *   authority its trigger needs still holds and the key is inside its 23-hour window, and
 *   otherwise becomes `uncertain`;
 * - an accepted send is looked up 24 hours on: provider evidence settles it, and a send the
 *   lookup cannot settle becomes `uncertain`.
 *
 * It never mints a new key: a second provider call under a new one is an audited operator resend.
 */
export class SendReconciler {
  constructor(private readonly deps: {
    intents: Pick<EmailSendIntentRepository, "claimDueForReconcile">;
    mailboxes: Pick<EmailMailboxRepository, "findById">;
    domains: Pick<EmailDomainRepository, "findById">;
    /** Read for an automatic send's authority before a re-POST. */
    ownership: EmailSendOwnershipReader;
    driver: Pick<EmailDriver, "lookup">;
    attempt: Pick<ProviderSendAttempt, "send" | "withinRepostWindow" | "recordDeliveredMessageId">;
    writer: Pick<SendIntentWriter, "apply">;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    logger: EmailChannelLogger;
    leaseSeconds?: number;
  }) {}

  async run(request: { maxJobs: number }): Promise<SendReconcileRun> {
    const run = emptyRun();
    const claimed = await this.deps.intents.claimDueForReconcile({
      limit: request.maxJobs,
      leaseSeconds: this.deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    });
    for (const intent of claimed) {
      run.claimed += 1;
      const action = intent.state === "queued" ? "repost" : "lookup";
      try {
        const result = await this.reconcile(intent);
        run[result] += 1;
        this.count(action, result);
      } catch (error) {
        // The claim runs out and a later sweep picks the intent up again.
        run.errored += 1;
        this.count(action, "error");
        this.deps.logger.warn(
          { sendIntentId: intent.id, conversationId: intent.conversationId, state: intent.state, errorName: error instanceof Error ? error.name : "unknown" },
          "email_send_reconcile_failed",
        );
      }
    }
    return run;
  }

  private async reconcile(intent: EmailSendIntentRecord): Promise<ReconcileResult> {
    if (intent.state === "queued") return this.repost(intent);
    if (intent.state === "accepted") return this.lookup(intent);
    return "skipped";
  }

  private async repost(intent: EmailSendIntentRecord): Promise<ReconcileResult> {
    // Only a send whose outcome was unknown is scheduled for a re-POST, and it has a frozen request.
    if (!intent.outcomeUnknown || intent.request === null) return "skipped";
    const mailbox = await this.deps.mailboxes.findById(intent.mailboxId);
    const domain = mailbox ? await this.deps.domains.findById(mailbox.domainId) : null;
    const ownership = intent.trigger === "auto_reply" ? await this.deps.ownership.load(intent.conversationId) : null;
    const authorityValid = repostAuthorized(intent, { mailbox, domain, ownership: ownershipFactsOf(ownership) });
    const withinWindow = this.deps.attempt.withinRepostWindow(intent);
    if (!authorityValid || !withinWindow) {
      await this.deps.writer.apply(intent, { kind: "outcome_unknown", authorityValid, withinWindow }, { writer: "reconciler" });
      return "uncertain";
    }
    try {
      const after = await this.deps.attempt.send(intent, { writer: "reconciler", attempt: null });
      return after.state === "uncertain" ? "uncertain" : "reposted";
    } catch (error) {
      if (error instanceof EmailSendRetryableError) return "deferred";
      throw error;
    }
  }

  private async lookup(intent: EmailSendIntentRecord): Promise<ReconcileResult> {
    if (intent.providerMessageId === null) return "skipped";
    let status: Awaited<ReturnType<EmailDriver["lookup"]>>;
    try {
      status = await this.deps.driver.lookup(intent.providerMessageId);
    } catch (error) {
      if (error instanceof EmailLookupError) return "deferred";
      throw error;
    }
    let result: ReconcileResult = "uncertain";
    if (status !== null) {
      const evidence = await this.deps.writer.apply(
        intent,
        { kind: "provider_status", status: status.lastEvent, source: "lookup" },
        { writer: "reconciler" },
      );
      // A status that does not settle the send leaves it to the next step.
      if (evidence.outcome === "applied" || (evidence.outcome === "ignored" && evidence.reason === "terminal")) result = "settled";
    }
    if (result === "uncertain") {
      await this.deps.writer.apply(intent, { kind: "reconcile_unsettled" }, { writer: "reconciler" });
    }
    if (status?.deliveredMessageId) await this.deps.attempt.recordDeliveredMessageId(intent, status.deliveredMessageId);
    return result;
  }

  private count(action: "repost" | "lookup", result: ReconcileResult | "error"): void {
    this.deps.metrics?.incrementCounter("email_send_reconciliations_total", {
      help: "Claimed send intents reconciled, by action and result.",
      labels: { action, result },
    });
  }
}
