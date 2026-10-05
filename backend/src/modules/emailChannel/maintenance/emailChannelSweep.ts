import type { HeldReplyDispatchPort } from "../../handoff/public.js";
import type { SendingDomainService } from "../domains/sendingDomainService.js";
import type { EmailChannelLogger } from "../emailChannelAudit.js";
import type { SendReconciler } from "../outbound/sendReconciler.js";
import type { EmailInboundRepository } from "../persistence/emailInboundRepository.js";
import { EMAIL_MAILBOX_POLICY_REF_PREFIX } from "../heldReplyChannelScope.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows one sweep may delete; the retention backlog drains over successive sweeps. */
const PURGE_BATCH = 1_000;
/** The action outbox's lease: a send queued more recently may still be in its own dispatch. */
const QUEUED_AUTO_STALE_MS = 5 * 60 * 1000;

/**
 * Returns queued automatic sends to a teammate where the deployment does not run `auto`. Each goes
 * through dispatch, whose authorization refuses there, so it moves back to `pending` under the same
 * locks and conditional update as a send whose authority changed, and nothing is sent.
 */
interface QueuedAutoRollback {
  queued: { listQueuedAutoBefore(input: { policyRefPrefix: string; before: Date; limit: number }): Promise<string[]> };
  dispatch: Pick<HeldReplyDispatchPort, "materializeAuto">;
}

interface EmailChannelSweepResult {
  recoveredLeases: number;
  refreshedDomains: number;
  cleanedDomains: number;
  purgedDeliveries: number;
  purgedEvents: number;
  reconciledSends: number;
  returnedQueuedAutoSends: number;
}

/**
 * The channel's periodic recovery and maintenance (research B7): it recovers inbound events a dead
 * worker left leased, claims and reconciles the sends due a re-POST or a lookup (research B18),
 * refreshes due domain readiness and cleans up removed domains with the provider, and enforces
 * event-log retention (research B10). Where the deployment does not run `auto`, it also returns
 * automatic sends left queued to a teammate (plan, Rollout and Rollback). Draining the recovered
 * work is the worker's job, after this runs.
 */
export class EmailChannelSweep {
  constructor(private readonly deps: {
    inbound: Pick<EmailInboundRepository, "releaseExpiredLeases" | "purgeUnattachedBefore">;
    domains: Pick<SendingDomainService, "refreshDue" | "cleanupRemoved">;
    sends: Pick<SendReconciler, "run">;
    clock: () => Date;
    logger: EmailChannelLogger;
    config: { eventRetentionDays: number };
    /** Composed only where the deployment does not run `auto`. */
    queuedAutoRollback?: QueuedAutoRollback;
  }) {}

  /** `maxJobs` bounds the leases recovered and the domains sent to the provider. */
  async run(request: { maxJobs: number }): Promise<EmailChannelSweepResult> {
    const recoveredLeases = await this.deps.inbound.releaseExpiredLeases(request.maxJobs);
    if (recoveredLeases > 0) {
      this.deps.logger.warn({ recoveredLeases }, "email_inbound_leases_recovered");
    }
    const reconciledSends = await this.reconcileSends(request);
    const refreshedDomains = await this.deps.domains.refreshDue(request.maxJobs);
    const cleanedDomains = await this.deps.domains.cleanupRemoved(request.maxJobs);
    const cutoff = new Date(this.deps.clock().getTime() - this.deps.config.eventRetentionDays * DAY_MS);
    const purged = await this.deps.inbound.purgeUnattachedBefore(cutoff, PURGE_BATCH);
    const returnedQueuedAutoSends = await this.returnQueuedAutoSends(request);
    return {
      recoveredLeases,
      refreshedDomains,
      cleanedDomains,
      purgedDeliveries: purged.deliveries,
      purgedEvents: purged.events,
      reconciledSends,
      returnedQueuedAutoSends,
    };
  }

  private async returnQueuedAutoSends(request: { maxJobs: number }): Promise<number> {
    const rollback = this.deps.queuedAutoRollback;
    if (!rollback) return 0;
    const stale = await rollback.queued.listQueuedAutoBefore({
      policyRefPrefix: EMAIL_MAILBOX_POLICY_REF_PREFIX,
      before: new Date(this.deps.clock().getTime() - QUEUED_AUTO_STALE_MS),
      limit: request.maxJobs,
    });
    let returned = 0;
    for (const heldReplyId of stale) {
      try {
        const outcome = await rollback.dispatch.materializeAuto(heldReplyId);
        if (!outcome.ok && outcome.reason === "returned_to_pending") returned += 1;
      } catch (error) {
        // The next sweep tries again; one held reply never stops the others.
        this.deps.logger.warn({ heldReplyId, errorName: error instanceof Error ? error.name : "unknown" }, "email_queued_auto_return_failed");
      }
    }
    if (returned > 0) {
      this.deps.logger.warn({ returnedQueuedAutoSends: returned }, "email_queued_auto_sends_returned");
    }
    return returned;
  }

  /**
   * Claims up to `maxJobs` sends due a re-POST or a lookup and reconciles them; also the work of a
   * scheduled `reconcile` drain. Returns how many it claimed.
   */
  async reconcileSends(request: { maxJobs: number }): Promise<number> {
    return (await this.deps.sends.run(request)).claimed;
  }
}
