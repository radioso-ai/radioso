import { domainToASCII } from "node:url";

import type { DnsRecordView, DomainReadiness, EmailDomainProvisioner, ProviderDomain } from "../../mail/public.js";
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
/** How far the provider's clock may run behind the database's. */
const PROVIDER_CLOCK_SKEW_MS = MINUTE_MS;

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
    | "claim"
    | "recordRegistration"
    | "releaseClaim"
    | "isProviderDomainActive"
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
 * Whether a registration the provider already holds was created by an attempt on this claim. No
 * other workspace could have registered the name while the claim held it, so one created since is
 * this claim's; an older one belongs to operations, another deployment sharing the account, or a
 * removed domain whose cleanup has not run.
 */
const createdForClaim = (found: ProviderDomain, claim: EmailDomainRecord): boolean =>
  found.createdAt !== null && found.createdAt.getTime() >= claim.createdAt.getTime() - PROVIDER_CLOCK_SKEW_MS;

const refusalError = (refused: DomainRefusal): AppError =>
  refused === "claimed_elsewhere"
    ? new AppError(409, "domain_claimed_elsewhere", "This domain is already registered to another workspace.")
    : new AppError(400, "invalid_domain", "Enter a domain name such as example.com.");

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
    if (!result.ok) throw refusalError(result.refused);
    return toEmailDomainView(result.domain);
  }

  /**
   * The workspace's active registration of `domainInput`, registering it with the provider the
   * first time. The workspace claims the domain before the provider is called, so a domain held by
   * another workspace, claimed or registered, is one `claimed_elsewhere` refusal that names no
   * workspace (AS1.4), and a registration interrupted after the provider accepted it is recovered
   * by the next attempt.
   */
  async ensureRegistered(actor: EmailChannelActor, workspaceId: string, domainInput: string): Promise<DomainRegistrationResult> {
    const domain = this.normalizeRegistrable(domainInput);
    if (!domain) return { ok: false, refused: "invalid_domain" };

    const claim = await this.deps.domains.claim({
      workspaceId,
      domain,
      provider: this.deps.provisioner.provider,
      createdByUserId: actor.userId,
    });
    if (claim.workspaceId !== workspaceId) return { ok: false, refused: "claimed_elsewhere" };
    if (claim.providerDomainId !== null) return { ok: true, domain: claim };
    return this.completeRegistration(actor, claim);
  }

  /** Asks the provider to check the records now, then records what it reports. */
  async verify(actor: EmailChannelActor, workspaceId: string, domainId: string): Promise<EmailDomainView> {
    const domain = await this.requireRegistered(actor, workspaceId, domainId);
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
    const domain = await this.requireRegistered(actor, workspaceId, domainId);
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
    const active = await this.requireActive(workspaceId, domainId);
    if ((await this.deps.mailboxes.countActiveOnDomain(active.id)) > 0) {
      throw new AppError(409, "domain_has_mailboxes", "Remove the mailboxes on this domain first.");
    }
    // An unfinished claim is settled first: a registration its attempts left at the provider is
    // recorded, so the cleanup removes it, rather than orphaned where no later claim may adopt it.
    const settled: DomainRegistrationResult = active.providerDomainId === null
      ? await this.completeRegistration(actor, active)
      : { ok: true, domain: active };
    if (!settled.ok) return;
    const { domain } = settled;
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
        const providerDomainId = await this.removableProviderDomainId(domain);
        if (providerDomainId) await this.deps.provisioner.remove(providerDomainId);
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

  /**
   * Registers a claimed domain with the provider and records the answer. When the provider already
   * holds the name, a registration created since the claim was taken is an earlier attempt's whose
   * answer was never recorded: it is found by name and adopted. Any other is claimed elsewhere.
   */
  private async completeRegistration(actor: EmailChannelActor, claim: EmailDomainRecord): Promise<DomainRegistrationResult> {
    const { domain } = claim;
    const registration = await this.callProvider("register", claim.id, () => this.deps.provisioner.registerSendingDomain(domain));
    if (!registration.ok && registration.refused === "invalid_domain") {
      await this.deps.domains.releaseClaim(claim.id);
      return { ok: false, refused: "invalid_domain" };
    }
    const recovered = !registration.ok;
    const providerDomain = registration.ok ? registration : await this.adoptableRegistration(claim);
    if (!providerDomain) {
      await this.deps.domains.releaseClaim(claim.id);
      return { ok: false, refused: "claimed_elsewhere" };
    }

    const { sending, receiving, records } = providerDomain.readiness;
    const registered = await this.deps.domains.recordRegistration(claim.id, {
      providerDomainId: providerDomain.providerDomainId,
      providerRegion: providerDomain.region,
      dnsRecords: records,
      sendingStatus: sending,
      receivingStatus: receiving,
      nextCheckAt: nextCheckAt(sending, receiving, this.deps.clock()),
    });
    if (!registered) {
      // A concurrent attempt on the same claim recorded first, or the claim was removed meanwhile.
      const holder = await this.deps.domains.findActiveByDomain(domain);
      if (holder?.workspaceId === claim.workspaceId && holder.providerDomainId !== null) return { ok: true, domain: holder };
      if (holder && holder.workspaceId !== claim.workspaceId) return { ok: false, refused: "claimed_elsewhere" };
      throw notFound("Email domain was not found");
    }

    if (recovered) this.deps.logger.warn({ domainId: registered.id }, "email_domain_registration_recovered");
    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.domain",
      action: "registered",
      actor,
      workspaceId: registered.workspaceId,
      metadata: { domainId: registered.id, domain, provider: registered.provider, region: registered.providerRegion, recovered },
    });
    return { ok: true, domain: registered };
  }

  /** The registration the provider already holds for a claimed name, when an attempt on this claim created it. */
  private async adoptableRegistration(claim: EmailDomainRecord): Promise<ProviderDomain | null> {
    const found = await this.callProvider("find_by_name", claim.id, () => this.deps.provisioner.findByName(claim.domain));
    return found && createdForClaim(found, claim) ? found : null;
  }

  /**
   * A removed domain's provider registration is removed with it, unless an active registration
   * has since adopted it: the same name added again before the cleanup ran.
   */
  private async removableProviderDomainId(domain: EmailDomainRecord): Promise<string | null> {
    const { provider, providerDomainId } = domain;
    if (providerDomainId === null) return null;
    return (await this.deps.domains.isProviderDomainActive(provider, providerDomainId)) ? null : providerDomainId;
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

  private async requireActive(workspaceId: string, domainId: string): Promise<EmailDomainRecord> {
    const domain = await this.deps.domains.findActive(workspaceId, domainId);
    if (!domain) throw notFound("Email domain was not found");
    return domain;
  }

  /** An active domain with its provider registration, finishing one an earlier attempt left claimed. */
  private async requireRegistered(actor: EmailChannelActor, workspaceId: string, domainId: string): Promise<EmailDomainRecord> {
    const domain = await this.requireActive(workspaceId, domainId);
    if (domain.providerDomainId !== null) return domain;
    const result = await this.completeRegistration(actor, domain);
    if (!result.ok) throw refusalError(result.refused);
    return result.domain;
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
