import { domainToASCII } from "node:url";

import type { DnsRecordView, DomainReadiness, EmailDomainProvisioner, ProviderDomain } from "../../mail/public.js";
import { AppError, notFound } from "../../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { recordEmailChannelAudit, type EmailChannelActor, type EmailChannelAuditDependencies } from "../emailChannelAudit.js";
import type {
  DomainReceivingStatus,
  DomainRegistrationStatus,
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
  registration: { status: DomainRegistrationStatus };
  sending: { status: DomainSendingStatus; checkedAt: string | null };
  receiving: { status: DomainReceivingStatus; checkedAt: string | null };
  records: DnsRecordView[];
}

interface SendingDomainServiceDependencies extends EmailChannelAuditDependencies {
  domains: Pick<
    EmailDomainRepository,
    | "claim"
    | "recordRegistration"
    | "markNeedsReconciliation"
    | "isRemovalPending"
    | "adoptRegistration"
    | "recordRemovedClaimRegistration"
    | "releaseClaim"
    | "findById"
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
  registration: { status: record.registrationStatus },
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

const removalPending = (): AppError =>
  new AppError(409, "domain_removal_pending", "This domain is still being removed from the email provider. Try again in a few minutes.");

const needsReconciliation = (): AppError =>
  new AppError(
    409,
    "domain_needs_reconciliation",
    "The email provider already has this domain registered. Reconcile the domain in the email channel settings to adopt that registration.",
  );

const refusalError = (refused: DomainRefusal): AppError =>
  refused === "claimed_elsewhere"
    ? new AppError(409, "domain_claimed_elsewhere", "This domain is already registered to another workspace.")
    : new AppError(400, "invalid_domain", "Enter a domain name such as example.com.");

/**
 * A workspace's own sending domains (and, as the advanced option, direct-receiving domains): one
 * active registration per domain across workspaces, readiness refreshed on a bounded cadence, and
 * removal that revokes authority before the provider is cleaned up.
 *
 * The provider account can hold registrations no claim made: operations', another deployment's
 * sharing the account, or one whose answer was lost. Nothing the provider reports ties one to a
 * claim, so a name the provider already holds waits as `needs_reconciliation` until an operator
 * adopts it with `reconcile`; nothing adopts it automatically.
 */
export class SendingDomainService {
  constructor(private readonly deps: SendingDomainServiceDependencies) {}

  async list(workspaceId: string): Promise<EmailDomainView[]> {
    return (await this.deps.domains.listActive(workspaceId)).map(toEmailDomainView);
  }

  /** Adds a sending domain directly (the settings card's "add domain"), in whatever registration status it reaches. */
  async add(actor: EmailChannelActor, workspaceId: string, domainInput: string): Promise<EmailDomainView> {
    const result = await this.claimAndRegister(actor, workspaceId, domainInput);
    if (!result.ok) throw refusalError(result.refused);
    return toEmailDomainView(result.domain);
  }

  /**
   * The workspace's registered domain `domainInput`, registering it with the provider the first
   * time. The workspace claims the domain before the provider is called, so a domain held by
   * another workspace, claimed or registered, is one `claimed_elsewhere` refusal that names no
   * workspace (AS1.4). A name the provider already holds is refused `domain_needs_reconciliation`
   * until an operator reconciles it.
   */
  async ensureRegistered(actor: EmailChannelActor, workspaceId: string, domainInput: string): Promise<DomainRegistrationResult> {
    const result = await this.claimAndRegister(actor, workspaceId, domainInput);
    if (result.ok && result.domain.registrationStatus !== "registered") throw needsReconciliation();
    return result;
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
   * Adopts, at an operator's request, the provider's existing registration of a domain waiting for
   * reconciliation: found by name, recorded for this workspace, and audited. When the provider no
   * longer holds the name, the domain is registered afresh. Refused while a removal of the name is
   * still being cleaned up, so a registration about to be deleted is never adopted.
   */
  async reconcile(actor: EmailChannelActor, workspaceId: string, domainId: string): Promise<EmailDomainView> {
    const claim = await this.requireActive(workspaceId, domainId);
    if (claim.registrationStatus === "registered") return toEmailDomainView(claim);
    if (claim.registrationStatus !== "needs_reconciliation") {
      throw new AppError(409, "domain_not_awaiting_reconciliation", "This domain is not waiting for reconciliation. Check it to finish its registration.");
    }
    // Checked before the lookup as well as at the adoption: a lookup that ran while a cleanup was
    // still deleting the registration it found must not be adopted afterwards.
    if (await this.deps.domains.isRemovalPending(claim.domain)) throw removalPending();
    const found = await this.callProvider("find_by_name", claim.id, () => this.deps.provisioner.findByName(claim.domain));
    if (!found) return this.registerAfresh(actor, claim);

    const adoption = await this.deps.domains.adoptRegistration(claim.id, this.registrationWrite(found));
    if (adoption.status === "removal_pending") throw removalPending();
    if (adoption.status === "not_awaiting") return this.currentView(workspaceId, claim.id);
    await this.auditReconciled(actor, adoption.domain, "adopted");
    return toEmailDomainView(adoption.domain);
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
        requestedVersion: domain.refreshRequestedVersion,
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
   * domain. The provider-side cleanup follows asynchronously, in `cleanupRemoved`; removing a claim
   * calls no provider at all.
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

  /**
   * The sweep's provider cleanup of removed domains. Returns how many were cleaned up. A removed
   * claim has no registration of its own to remove: one an interrupted attempt left at the provider
   * cannot be told apart from another writer's, so it is reconciled when the name is added again.
   */
  async cleanupRemoved(limit: number): Promise<number> {
    let cleaned = 0;
    for (const domain of await this.deps.domains.listCleanupDue(limit)) {
      const { providerDomainId } = domain;
      try {
        if (providerDomainId) await this.deps.provisioner.remove(providerDomainId);
        await this.deps.domains.recordCleanup(domain.id, { status: "done", retryAt: null, providerDomainId });
        cleaned += 1;
      } catch (error) {
        this.deps.logger.warn({ domainId: domain.id, errorName: errorName(error) }, "email_domain_cleanup_failed");
        await this.deps.domains.recordCleanup(domain.id, {
          status: "failed",
          retryAt: new Date(this.deps.clock().getTime() + CLEANUP_RETRY_MS),
          providerDomainId,
        });
      }
    }
    return cleaned;
  }

  /** Claims the domain for the workspace and, the first time, registers it with the provider. */
  private async claimAndRegister(actor: EmailChannelActor, workspaceId: string, domainInput: string): Promise<DomainRegistrationResult> {
    const domain = this.normalizeRegistrable(domainInput);
    if (!domain) return { ok: false, refused: "invalid_domain" };

    const claim = await this.deps.domains.claim({
      workspaceId,
      domain,
      provider: this.deps.provisioner.provider,
      createdByUserId: actor.userId,
    });
    if (claim.status === "removal_pending") throw removalPending();
    if (claim.domain.workspaceId !== workspaceId) return { ok: false, refused: "claimed_elsewhere" };
    if (claim.domain.registrationStatus !== "registering") return { ok: true, domain: claim.domain };
    return this.completeRegistration(actor, claim.domain);
  }

  /**
   * Registers a claimed domain with the provider and records the answer. When the provider already
   * holds the name, the claim waits for an operator's reconcile.
   */
  private async completeRegistration(actor: EmailChannelActor, claim: EmailDomainRecord): Promise<DomainRegistrationResult> {
    const registration = await this.callProvider("register", claim.id, () => this.deps.provisioner.registerSendingDomain(claim.domain));
    if (registration.ok) return { ok: true, domain: await this.recordCreated(claim, registration, (domain) => this.auditRegistered(actor, domain)) };
    if (registration.refused === "invalid_domain") {
      await this.deps.domains.releaseClaim(claim.id);
      return { ok: false, refused: "invalid_domain" };
    }
    return { ok: true, domain: await this.awaitReconciliation(actor, claim) };
  }

  /** `reconcile` when the provider no longer holds the name: a fresh registration, audited as the reconcile's outcome. */
  private async registerAfresh(actor: EmailChannelActor, claim: EmailDomainRecord): Promise<EmailDomainView> {
    const registration = await this.callProvider("register", claim.id, () => this.deps.provisioner.registerSendingDomain(claim.domain));
    if (!registration.ok) return this.currentView(claim.workspaceId, claim.id);
    const registered = await this.recordCreated(claim, registration, (domain) => this.auditReconciled(actor, domain, "registered"));
    return toEmailDomainView(registered);
  }

  /**
   * Records the registration a create on `claim` returned. A claim removed while the create ran
   * hands the registration to its cleanup, since it is provably the claim's own.
   */
  private async recordCreated(
    claim: EmailDomainRecord,
    created: ProviderDomain,
    audit: (domain: EmailDomainRecord) => Promise<void>,
  ): Promise<EmailDomainRecord> {
    const registered = await this.deps.domains.recordRegistration(claim.id, this.registrationWrite(created));
    if (registered) {
      await audit(registered);
      return registered;
    }
    const current = await this.deps.domains.findById(claim.id);
    if (current && current.removedAt === null && current.registrationStatus === "registered") return current;
    if (current?.removedAt) {
      const handedOver = await this.deps.domains.recordRemovedClaimRegistration(claim.id, {
        providerDomainId: created.providerDomainId,
        providerRegion: created.region,
      });
      if (!handedOver) this.deps.logger.warn({ domainId: claim.id }, "email_domain_registration_unclaimed");
    }
    throw notFound("Email domain was not found");
  }

  private async awaitReconciliation(actor: EmailChannelActor, claim: EmailDomainRecord): Promise<EmailDomainRecord> {
    const marked = await this.deps.domains.markNeedsReconciliation(claim.id);
    if (!marked) {
      // A concurrent attempt on the same claim settled it first, or the claim was removed meanwhile.
      const current = await this.deps.domains.findById(claim.id);
      if (!current || current.removedAt !== null) throw notFound("Email domain was not found");
      return current;
    }
    this.deps.logger.warn({ domainId: marked.id }, "email_domain_needs_reconciliation");
    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.domain",
      action: "reconciliation_required",
      actor,
      workspaceId: marked.workspaceId,
      metadata: { domainId: marked.id, domain: marked.domain, provider: marked.provider },
    });
    return marked;
  }

  private registrationWrite(providerDomain: ProviderDomain) {
    const { sending, receiving, records } = providerDomain.readiness;
    return {
      providerDomainId: providerDomain.providerDomainId,
      providerRegion: providerDomain.region,
      dnsRecords: records,
      sendingStatus: sending,
      receivingStatus: receiving,
      nextCheckAt: nextCheckAt(sending, receiving, this.deps.clock()),
    };
  }

  private async auditRegistered(actor: EmailChannelActor, domain: EmailDomainRecord): Promise<void> {
    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.domain",
      action: "registered",
      actor,
      workspaceId: domain.workspaceId,
      metadata: { domainId: domain.id, domain: domain.domain, provider: domain.provider, region: domain.providerRegion },
    });
  }

  private async auditReconciled(actor: EmailChannelActor, domain: EmailDomainRecord, outcome: "adopted" | "registered"): Promise<void> {
    await recordEmailChannelAudit(this.deps, {
      eventType: "email_channel.domain",
      action: "reconciled",
      actor,
      workspaceId: domain.workspaceId,
      metadata: { domainId: domain.id, domain: domain.domain, provider: domain.provider, region: domain.providerRegion, outcome },
    });
  }

  private async refresh(domain: EmailDomainRecord): Promise<boolean> {
    let readiness: DomainReadiness;
    try {
      readiness = await this.deps.provisioner.readiness({ providerDomainId: this.providerDomainIdOf(domain), domain: domain.domain });
    } catch (error) {
      this.deps.logger.warn({ domainId: domain.id, errorName: errorName(error) }, "email_domain_refresh_failed");
      await this.deps.domains.deferRefresh(
        domain.id,
        new Date(this.deps.clock().getTime() + REFRESH_AFTER_MS.pending),
        domain.refreshRequestedVersion,
      );
      return false;
    }
    return (await this.applyReadiness(domain, readiness, null)) !== null;
  }

  /** Records a reading of `domain`; null when it was removed, or a provider event since keeps it due. */
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
      requestedVersion: domain.refreshRequestedVersion,
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

  private async currentView(workspaceId: string, domainId: string): Promise<EmailDomainView> {
    return toEmailDomainView(await this.requireActive(workspaceId, domainId));
  }

  /** An active domain with its provider registration, finishing one an earlier attempt left `registering`. */
  private async requireRegistered(actor: EmailChannelActor, workspaceId: string, domainId: string): Promise<EmailDomainRecord> {
    const domain = await this.requireActive(workspaceId, domainId);
    if (domain.registrationStatus === "registered") return domain;
    if (domain.registrationStatus === "needs_reconciliation") throw needsReconciliation();
    const result = await this.completeRegistration(actor, domain);
    if (!result.ok) throw refusalError(result.refused);
    if (result.domain.registrationStatus !== "registered") throw needsReconciliation();
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
