import { domainToASCII } from "node:url";

import type { DnsRecordView, DomainReadiness, EmailDomainProvisioner } from "../../mail/public.js";
import { AppError, notFound } from "../../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { recordEmailChannelAudit, type EmailChannelActor, type EmailChannelAuditDependencies } from "../emailChannelAudit.js";
import type {
  DomainReceivingStatus,
  DomainSendingStatus,
  EmailDomainRecord,
  EmailDomainRepository,
} from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** How soon a domain is checked again, by the least settled status it has (FR-003). */
const REFRESH_AFTER_MS: Readonly<Record<DomainSendingStatus, number>> = {
  pending: 10 * MINUTE_MS,
  failed: 6 * HOUR_MS,
  verified: 24 * HOUR_MS,
};
const CLEANUP_RETRY_MS = HOUR_MS;

// Structural DNS hostname syntax: at least two labels of letters, digits and inner hyphens.
const DNS_HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_LABEL = /^\d+$/;

type DomainRefusal = "claimed_elsewhere" | "invalid_domain";
type Capability = "sending" | "receiving";

type DomainRegistrationResult = { ok: true; domain: EmailDomainRecord } | { ok: false; refused: DomainRefusal };

interface EmailDomainView {
  id: string;
  domain: string;
  sending: { status: DomainSendingStatus; checkedAt: string | null };
  receiving: { status: DomainReceivingStatus; checkedAt: string | null };
  records: DnsRecordView[];
}

interface SendingDomainServiceDependencies extends EmailChannelAuditDependencies {
  domains: Pick<
    EmailDomainRepository,
    | "insertActive"
    | "findActiveByDomain"
    | "findActive"
    | "listActive"
    | "listDueForRefresh"
    | "recordReadiness"
    | "deferRefresh"
    | "confirmReceiving"
    | "markRemoved"
    | "listCleanupDue"
    | "recordCleanup"
  >;
  mailboxes: Pick<EmailMailboxRepository, "countActiveOnDomain">;
  provisioner: EmailDomainProvisioner;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  clock: () => Date;
  /** The deployment's relay domain; never registrable as a workspace's own domain. */
  inboundDomain: string;
}

/** Lowercase IDNA A-label of a DNS hostname, or null when the input is not one. */
export const normalizeDomainName = (input: string): string | null => {
  const trimmed = input.trim().toLowerCase().replace(/\.$/u, "");
  if (trimmed === "") return null;
  const ascii = domainToASCII(trimmed);
  if (!ascii || !DNS_HOSTNAME.test(ascii)) return null;
  return NUMERIC_LABEL.test(ascii.slice(ascii.lastIndexOf(".") + 1)) ? null : ascii;
};

const toIso = (value: Date | null): string | null => value?.toISOString() ?? null;

const toEmailDomainView = (record: EmailDomainRecord): EmailDomainView => ({
  id: record.id,
  domain: record.domain,
  sending: { status: record.sendingStatus, checkedAt: toIso(record.lastCheckedAt) },
  receiving: { status: record.receivingStatus, checkedAt: toIso(record.lastCheckedAt) },
  records: record.dnsRecords.map((dnsRecord) => ({ ...dnsRecord })),
});

const nextCheckAt = (sending: DomainSendingStatus, receiving: DomainReceivingStatus, now: Date): Date => {
  const statuses = receiving === "not_requested" ? [sending] : [sending, receiving];
  return new Date(now.getTime() + Math.min(...statuses.map((status) => REFRESH_AFTER_MS[status])));
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const providerUnavailable = (): AppError =>
  new AppError(502, "provider_unavailable", "The email provider could not be reached. Try again shortly.");

/**
 * A workspace's own sending domains (and, as the advanced option, direct-receiving domains): one
 * active registration per domain across workspaces, readiness refreshed on a bounded cadence, and
 * removal that revokes authority before the provider is cleaned up.
 */
export class SendingDomainService {
  constructor(private readonly deps: SendingDomainServiceDependencies) {}

  async list(workspaceId: string): Promise<EmailDomainView[]> {
    return (await this.deps.domains.listActive(workspaceId)).map(toEmailDomainView);
  }

  /** Adds a sending domain directly (the settings card's "add domain"). */
  async add(actor: EmailChannelActor, workspaceId: string, domainInput: string): Promise<EmailDomainView> {
    const result = await this.ensureRegistered(actor, workspaceId, domainInput);
    if (!result.ok) {
      throw result.refused === "claimed_elsewhere"
        ? new AppError(409, "domain_claimed_elsewhere", "This domain is already registered to another workspace.")
        : new AppError(400, "invalid_domain", "Enter a domain name such as example.com.");
    }
    return toEmailDomainView(result.domain);
  }

  /**
   * The workspace's active registration of `domainInput`, registering it with the provider the
   * first time. A domain active in another workspace, whether the database or the provider says
   * so, is one `claimed_elsewhere` refusal that names no workspace (AS1.4).
   */
  async ensureRegistered(actor: EmailChannelActor, workspaceId: string, domainInput: string): Promise<DomainRegistrationResult> {
    const domain = this.normalizeRegistrable(domainInput);
    if (!domain) return { ok: false, refused: "invalid_domain" };

    const existing = await this.deps.domains.findActiveByDomain(domain);
    if (existing) return this.ownedBy(workspaceId, existing);

    const registration = await this.callProvider("register", null, () => this.deps.provisioner.registerSendingDomain(domain));
    if (!registration.ok) return { ok: false, refused: registration.refused };

    const { sending, receiving, records } = registration.readiness;
    const inserted = await this.deps.domains.insertActive({
      workspaceId,
      domain,
      provider: this.deps.provisioner.provider,
      providerDomainId: registration.providerDomainId,
      providerRegion: registration.region,
      dnsRecords: records,
      sendingStatus: sending,
      receivingStatus: receiving,
      nextCheckAt: nextCheckAt(sending, receiving, this.deps.clock()),
      createdByUserId: actor.userId,
    });
    if (!inserted) {
      // Another registration of the same domain committed first.
      const winner = await this.deps.domains.findActiveByDomain(domain);
      return winner ? this.ownedBy(workspaceId, winner) : { ok: false, refused: "claimed_elsewhere" };
    }

    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.domain",
      action: "registered",
      actor,
      workspaceId,
      metadata: { domainId: inserted.id, domain, provider: inserted.provider, region: inserted.providerRegion },
    });
    return { ok: true, domain: inserted };
  }

  /** Asks the provider to check the records now, then records what it reports. */
  async verify(actor: EmailChannelActor, workspaceId: string, domainId: string): Promise<EmailDomainView> {
    const domain = await this.requireActive(workspaceId, domainId);
    const providerDomainId = this.providerDomainIdOf(domain);
    await this.callProvider("request_verification", domain.id, () => this.deps.provisioner.requestVerification(providerDomainId));
    const readiness = await this.callProvider("readiness", domain.id, () =>
      this.deps.provisioner.readiness({ providerDomainId, domain: domain.domain }));
    return toEmailDomainView((await this.applyReadiness(domain, readiness, actor)) ?? domain);
  }

  /**
   * Enables the advanced direct-receiving option (FR-006a). The operator must type the domain,
   * because every address on it will then route to Radioso.
   */
  async enableReceiving(
    actor: EmailChannelActor,
    workspaceId: string,
    domainId: string,
    confirmation: string,
  ): Promise<EmailDomainView> {
    const domain = await this.requireActive(workspaceId, domainId);
    if (normalizeDomainName(confirmation) !== domain.domain) {
      throw new AppError(400, "confirmation_mismatch", "Type the domain name exactly to confirm that all of its mail will route to Radioso.");
    }
    const providerDomainId = this.providerDomainIdOf(domain);
    const readiness = await this.callProvider("enable_receiving", domain.id, () => this.deps.provisioner.enableReceiving(providerDomainId));
    const receivingStatus = readiness.receiving === "not_requested" ? "pending" : readiness.receiving;
    const updated = await this.deps.domains.confirmReceiving(domain.id, {
      confirmedByUserId: actor.userId,
      readiness: {
        sendingStatus: readiness.sending,
        receivingStatus,
        dnsRecords: readiness.records,
        nextCheckAt: nextCheckAt(readiness.sending, receivingStatus, this.deps.clock()),
        statusChanged: readiness.sending !== domain.sendingStatus || receivingStatus !== domain.receivingStatus,
      },
    });
    if (!updated) throw notFound("Email domain was not found");

    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.domain",
      action: "receiving_enabled",
      actor,
      workspaceId,
      metadata: { domainId: domain.id, confirmedByUserId: actor.userId },
    });
    await this.recordTransitions(domain, updated, actor);
    return toEmailDomainView(updated);
  }

  /**
   * Removes a domain (FR-006b). Authority is revoked at once: every lookup ignores a removed
   * domain. The provider-side cleanup follows asynchronously, in `cleanupRemoved`.
   */
  async remove(actor: EmailChannelActor, workspaceId: string, domainId: string): Promise<void> {
    const domain = await this.requireActive(workspaceId, domainId);
    if ((await this.deps.mailboxes.countActiveOnDomain(domain.id)) > 0) {
      throw new AppError(409, "domain_has_mailboxes", "Remove the mailboxes on this domain first.");
    }
    if (!(await this.deps.domains.markRemoved(workspaceId, domain.id))) throw notFound("Email domain was not found");
    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.domain",
      action: "removed",
      actor,
      workspaceId,
      metadata: { domainId: domain.id, domain: domain.domain, haltedSendCount: 0 },
    });
  }

  /** The sweep's readiness refresh of due domains. Returns how many were refreshed. */
  async refreshDue(limit: number): Promise<number> {
    let refreshed = 0;
    for (const domain of await this.deps.domains.listDueForRefresh(limit)) {
      if (await this.refresh(domain)) refreshed += 1;
    }
    return refreshed;
  }

  /** The sweep's provider cleanup of removed domains. Returns how many were cleaned up. */
  async cleanupRemoved(limit: number): Promise<number> {
    let cleaned = 0;
    for (const domain of await this.deps.domains.listCleanupDue(limit)) {
      try {
        if (domain.providerDomainId) await this.deps.provisioner.remove(domain.providerDomainId);
        await this.deps.domains.recordCleanup(domain.id, { status: "done", retryAt: null });
        cleaned += 1;
      } catch (error) {
        this.deps.logger.warn({ domainId: domain.id, errorName: errorName(error) }, "email_domain_cleanup_failed");
        await this.deps.domains.recordCleanup(domain.id, {
          status: "failed",
          retryAt: new Date(this.deps.clock().getTime() + CLEANUP_RETRY_MS),
        });
      }
    }
    return cleaned;
  }

  private async refresh(domain: EmailDomainRecord): Promise<boolean> {
    let readiness: DomainReadiness;
    try {
      readiness = await this.deps.provisioner.readiness({ providerDomainId: this.providerDomainIdOf(domain), domain: domain.domain });
    } catch (error) {
      this.deps.logger.warn({ domainId: domain.id, errorName: errorName(error) }, "email_domain_refresh_failed");
      await this.deps.domains.deferRefresh(domain.id, new Date(this.deps.clock().getTime() + REFRESH_AFTER_MS.pending));
      return false;
    }
    return (await this.applyReadiness(domain, readiness, null)) !== null;
  }

  private async applyReadiness(
    domain: EmailDomainRecord,
    readiness: DomainReadiness,
    actor: EmailChannelActor | null,
  ): Promise<EmailDomainRecord | null> {
    const updated = await this.deps.domains.recordReadiness(domain.id, {
      sendingStatus: readiness.sending,
      receivingStatus: readiness.receiving,
      dnsRecords: readiness.records,
      nextCheckAt: nextCheckAt(readiness.sending, readiness.receiving, this.deps.clock()),
      statusChanged: readiness.sending !== domain.sendingStatus || readiness.receiving !== domain.receivingStatus,
    });
    if (updated) await this.recordTransitions(domain, updated, actor);
    return updated;
  }

  private async recordTransitions(
    before: EmailDomainRecord,
    after: EmailDomainRecord,
    actor: EmailChannelActor | null,
  ): Promise<void> {
    const transitions: { capability: Capability; from: string; to: string }[] = [
      { capability: "sending", from: before.sendingStatus, to: after.sendingStatus },
      { capability: "receiving", from: before.receivingStatus, to: after.receivingStatus },
    ];
    for (const { capability, from, to } of transitions) {
      if (from === to) continue;
      this.deps.metrics?.incrementCounter("email_domain_readiness_transitions_total", {
        help: "Email domain readiness transitions by capability and new status.",
        labels: { capability, to },
      });
      if (capability === "sending" && from === "verified") {
        this.deps.logger.warn({ domainId: after.id, to }, "email_domain_readiness_lost");
      }
      await recordEmailChannelAudit(this.deps, {
        eventType: "email_channel.domain",
        action: "readiness_changed",
        actor,
        workspaceId: after.workspaceId,
        metadata: { domainId: after.id, capability, from, to },
      });
    }
  }

  private normalizeRegistrable(domainInput: string): string | null {
    const domain = normalizeDomainName(domainInput);
    const inbound = this.deps.inboundDomain.toLowerCase();
    if (!domain || domain === inbound || domain.endsWith(`.${inbound}`)) return null;
    return domain;
  }

  private ownedBy(workspaceId: string, domain: EmailDomainRecord): DomainRegistrationResult {
    return domain.workspaceId === workspaceId ? { ok: true, domain } : { ok: false, refused: "claimed_elsewhere" };
  }

  private async requireActive(workspaceId: string, domainId: string): Promise<EmailDomainRecord> {
    const domain = await this.deps.domains.findActive(workspaceId, domainId);
    if (!domain) throw notFound("Email domain was not found");
    return domain;
  }

  private providerDomainIdOf(domain: EmailDomainRecord): string {
    if (!domain.providerDomainId) throw new Error(`Email domain ${domain.id} has no provider registration`);
    return domain.providerDomainId;
  }

  private async callProvider<T>(operation: string, domainId: string | null, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.deps.logger.warn({ operation, domainId, errorName: errorName(error) }, "email_domain_provider_call_failed");
      throw providerUnavailable();
    }
  }
}
