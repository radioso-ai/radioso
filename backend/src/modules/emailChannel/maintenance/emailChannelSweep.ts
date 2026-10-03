import type { SendingDomainService } from "../domains/sendingDomainService.js";
import type { EmailChannelLogger } from "../emailChannelAudit.js";
import type { EmailInboundRepository } from "../persistence/emailInboundRepository.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows one sweep may delete; the retention backlog drains over successive sweeps. */
const PURGE_BATCH = 1_000;

interface EmailChannelSweepResult {
  recoveredLeases: number;
  refreshedDomains: number;
  cleanedDomains: number;
  purgedDeliveries: number;
  purgedEvents: number;
}

/**
 * The channel's periodic recovery and maintenance (research B7): it recovers inbound events a dead
 * worker left leased, refreshes due domain readiness and cleans up removed domains with the
 * provider, and enforces event-log retention (research B10). Draining the recovered work is the
 * worker's job, after this runs.
 */
export class EmailChannelSweep {
  constructor(private readonly deps: {
    inbound: Pick<EmailInboundRepository, "releaseExpiredLeases" | "purgeUnattachedBefore">;
    domains: Pick<SendingDomainService, "refreshDue" | "cleanupRemoved">;
    clock: () => Date;
    logger: EmailChannelLogger;
    config: { eventRetentionDays: number };
  }) {}

  /** `maxJobs` bounds the leases recovered and the domains sent to the provider. */
  async run(request: { maxJobs: number }): Promise<EmailChannelSweepResult> {
    const recoveredLeases = await this.deps.inbound.releaseExpiredLeases(request.maxJobs);
    if (recoveredLeases > 0) {
      this.deps.logger.warn({ recoveredLeases }, "email_inbound_leases_recovered");
    }
    const refreshedDomains = await this.deps.domains.refreshDue(request.maxJobs);
    const cleanedDomains = await this.deps.domains.cleanupRemoved(request.maxJobs);
    const cutoff = new Date(this.deps.clock().getTime() - this.deps.config.eventRetentionDays * DAY_MS);
    const purged = await this.deps.inbound.purgeUnattachedBefore(cutoff, PURGE_BATCH);
    return {
      recoveredLeases,
      refreshedDomains,
      cleanedDomains,
      purgedDeliveries: purged.deliveries,
      purgedEvents: purged.events,
    };
  }
}
