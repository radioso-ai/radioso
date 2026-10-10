import { describe, expect, it, vi } from "vitest";

import type { AuditEventInput } from "../../../src/modules/audit/contracts/index.js";
import type { DomainReadiness, EmailDomainProvisioner } from "../../../src/modules/mail/public.js";
import { SendingDomainService } from "../../../src/modules/emailChannel/public.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { InMemoryEmailDomains } from "../../support/inMemoryEmailChannel.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const actor = { userId: "33333333-3333-4333-8333-333333333333", accountId: null };

const readiness = (sending: DomainReadiness["sending"], receiving: DomainReadiness["receiving"] = "not_requested"): DomainReadiness => ({
  sending,
  receiving,
  records: [{ purpose: "dkim", type: "TXT", name: "resend._domainkey.customer.test", value: "p=abc", status: sending }],
});

/** A promise the test settles by hand, to pause a provider call at a chosen point. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const harness = () => {
  let now = new Date("2026-10-03T12:00:00.000Z");
  const clock = () => now;
  const domains = new InMemoryEmailDomains(clock);
  // The provider account: one registration per name, as Resend keeps them. A name registered
  // again after its removal gets a new id.
  const providerDomains = new Map<string, string>();
  const registrations = new Map<string, number>();
  const providerDomainOf = (providerDomainId: string) => ({
    providerDomainId,
    region: "eu-west-1",
    readiness: readiness("pending"),
  });
  const registerAtProvider = (domain: string): string => {
    const generation = (registrations.get(domain) ?? 0) + 1;
    registrations.set(domain, generation);
    const providerDomainId = generation === 1 ? `provider-${domain}` : `provider-${domain}#${generation}`;
    providerDomains.set(domain, providerDomainId);
    return providerDomainId;
  };
  const provisioner = {
    provider: "local",
    registerSendingDomain: vi.fn<EmailDomainProvisioner["registerSendingDomain"]>(async (domain) => {
      if (providerDomains.has(domain)) return { ok: false, refused: "already_registered" };
      return { ok: true, ...providerDomainOf(registerAtProvider(domain)) };
    }),
    findByName: vi.fn<EmailDomainProvisioner["findByName"]>(async (domain) => {
      const providerDomainId = providerDomains.get(domain);
      return providerDomainId ? providerDomainOf(providerDomainId) : null;
    }),
    enableReceiving: vi.fn<EmailDomainProvisioner["enableReceiving"]>(async () => readiness("verified", "pending")),
    requestVerification: vi.fn<EmailDomainProvisioner["requestVerification"]>(async () => undefined),
    readiness: vi.fn<EmailDomainProvisioner["readiness"]>(async () => readiness("pending")),
    remove: vi.fn<EmailDomainProvisioner["remove"]>(async (providerDomainId) => {
      for (const [domain, id] of providerDomains) if (id === providerDomainId) providerDomains.delete(domain);
    }),
  };
  const mailboxes = { countActiveOnDomain: vi.fn(async (_domainId: string) => 0) };
  const audit = { record: vi.fn(async (_event: AuditEventInput) => undefined) };
  const logger = { warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const service = new SendingDomainService({
    domains,
    mailboxes,
    provisioner,
    audit,
    logger,
    metrics,
    clock,
    inboundDomain: "in.radioso.test",
  });
  const auditMetadata = (action: string) =>
    audit.record.mock.calls.map(([event]) => event).filter((event) => event.metadata?.action === action);
  return {
    service,
    domains,
    provisioner,
    providerDomains,
    registerAtProvider,
    mailboxes,
    audit,
    auditMetadata,
    logger,
    metrics,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
};

const expectAppError = async (work: Promise<unknown>, statusCode: number, code: string): Promise<AppError> => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode, code });
  return error as AppError;
};

describe("SendingDomainService", () => {
  describe("registration", () => {
    it("registers the domain with the provider for the workspace's first mailbox and reuses it after", async () => {
      const { service, domains, provisioner, auditMetadata, now } = harness();

      const first = await service.ensureRegistered(actor, workspaceId, "customer.test");
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(provisioner.registerSendingDomain).toHaveBeenCalledWith("customer.test");
      expect(first.domain).toMatchObject({
        workspaceId,
        domain: "customer.test",
        provider: "local",
        providerDomainId: "provider-customer.test",
        providerRegion: "eu-west-1",
        registrationStatus: "registered",
        sendingStatus: "pending",
        receivingStatus: "not_requested",
        createdByUserId: actor.userId,
      });
      expect(first.domain.nextCheckAt?.getTime()).toBe(now().getTime() + 10 * MINUTE_MS);

      const second = await service.ensureRegistered(actor, workspaceId, "customer.test");
      expect(second).toEqual({ ok: true, domain: first.domain });
      expect(provisioner.registerSendingDomain).toHaveBeenCalledTimes(1);
      expect(domains.records.size).toBe(1);
      expect(auditMetadata("registered")).toEqual([
        expect.objectContaining({
          eventType: "email_channel.domain",
          workspaceId,
          metadata: expect.objectContaining({
            domainId: first.domain.id,
            domain: "customer.test",
            provider: "local",
            region: "eu-west-1",
            actorUserId: actor.userId,
          }),
        }),
      ]);
    });

    it("adds a domain directly, normalizing case and internationalized names to the A-label", async () => {
      const { service } = harness();
      const view = await service.add(actor, workspaceId, "  Bücher.Example  ");
      expect(view).toMatchObject({
        domain: "xn--bcher-kva.example",
        registration: { status: "registered" },
        sending: { status: "pending" },
        receiving: { status: "not_requested" },
        records: [expect.objectContaining({ purpose: "dkim", status: "pending" })],
      });
      expect(await service.list(workspaceId)).toEqual([view]);
    });

    it("refuses an invalid domain and the deployment's own inbound domain without calling the provider", async () => {
      const { service, provisioner } = harness();
      for (const input of ["not a domain", "localhost", "in.radioso.test", "sub.in.radioso.test", "a..b.test"]) {
        await expectAppError(service.add(actor, workspaceId, input), 400, "invalid_domain");
      }
      expect(await service.ensureRegistered(actor, workspaceId, "in.radioso.test")).toEqual({ ok: false, refused: "invalid_domain" });
      expect(provisioner.registerSendingDomain).not.toHaveBeenCalled();
    });

    it("gives one claimed_elsewhere refusal for a database conflict, naming no workspace", async () => {
      const { service, provisioner } = harness();
      await service.ensureRegistered(actor, otherWorkspaceId, "customer.test");
      provisioner.registerSendingDomain.mockClear();

      expect(await service.ensureRegistered(actor, workspaceId, "customer.test")).toEqual({ ok: false, refused: "claimed_elsewhere" });
      expect(provisioner.registerSendingDomain).not.toHaveBeenCalled();

      const error = await expectAppError(service.add(actor, workspaceId, "customer.test"), 409, "domain_claimed_elsewhere");
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(otherWorkspaceId);
    });

    it("releases the claim when the provider refuses the name itself", async () => {
      const { service, provisioner, domains } = harness();
      provisioner.registerSendingDomain.mockResolvedValueOnce({ ok: false, refused: "invalid_domain" });
      expect(await service.ensureRegistered(actor, workspaceId, "customer.test")).toEqual({ ok: false, refused: "invalid_domain" });
      expect(domains.records.size).toBe(0);
    });

    it("gives the same refusal, without calling the provider, when another workspace wins the claim race", async () => {
      const { service, domains, provisioner } = harness();
      const claim = domains.claim.bind(domains);
      vi.spyOn(domains, "claim").mockImplementationOnce(async (input) => {
        domains.seed({ workspaceId: otherWorkspaceId, domain: input.domain });
        return claim(input);
      });
      expect(await service.ensureRegistered(actor, workspaceId, "customer.test")).toEqual({ ok: false, refused: "claimed_elsewhere" });
      expect(provisioner.registerSendingDomain).not.toHaveBeenCalled();
    });

    it("settles on one registration when the workspace's two mailboxes race to register the domain", async () => {
      const { service, domains, auditMetadata } = harness();
      const [first, second] = await Promise.all([
        service.ensureRegistered(actor, workspaceId, "customer.test"),
        service.ensureRegistered(actor, workspaceId, "customer.test"),
      ]);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.domain.id).toBe(first.domain.id);
      expect(first.domain.providerDomainId).toBe("provider-customer.test");
      expect(domains.records.size).toBe(1);
      expect(auditMetadata("registered")).toHaveLength(1);
    });
  });

  describe("a name the provider already holds", () => {
    const loseTheAnswer = (h: ReturnType<typeof harness>) => {
      h.provisioner.registerSendingDomain.mockImplementationOnce(async (domain) => {
        h.registerAtProvider(domain);
        throw new Error("socket hang up");
      });
    };

    it("keeps the claim as needs_reconciliation and adopts nothing, even a registration made moments before", async () => {
      const h = harness();
      const { service, domains, provisioner, auditMetadata, logger } = h;
      // Registered on the account seconds ago by operations, or by another deployment sharing it.
      h.registerAtProvider("customer.test");

      const view = await service.add(actor, workspaceId, "customer.test");

      expect(view).toMatchObject({ domain: "customer.test", registration: { status: "needs_reconciliation" }, records: [] });
      expect(await domains.findById(view.id)).toMatchObject({ workspaceId, providerDomainId: null, nextCheckAt: null });
      expect(provisioner.findByName).not.toHaveBeenCalled();
      expect(auditMetadata("reconciliation_required").map((event) => event.metadata)).toEqual([
        expect.objectContaining({ domainId: view.id, domain: "customer.test" }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith({ domainId: view.id }, "email_domain_needs_reconciliation");
      expect(await service.list(workspaceId)).toEqual([view]);

      // Nothing but the explicit reconcile adopts it: neither a mailbox, nor a check, nor adding it again.
      await expectAppError(service.ensureRegistered(actor, workspaceId, "customer.test"), 409, "domain_needs_reconciliation");
      await expectAppError(service.verify(actor, workspaceId, view.id), 409, "domain_needs_reconciliation");
      await expectAppError(service.enableReceiving(actor, workspaceId, view.id, "customer.test"), 409, "domain_needs_reconciliation");
      expect(await service.add(actor, workspaceId, "customer.test")).toEqual(view);
      expect(provisioner.registerSendingDomain).toHaveBeenCalledTimes(1);
      expect(provisioner.findByName).not.toHaveBeenCalled();
      expect(provisioner.requestVerification).not.toHaveBeenCalled();
      expect(await service.ensureRegistered(actor, otherWorkspaceId, "customer.test")).toEqual({ ok: false, refused: "claimed_elsewhere" });
    });

    it("waits for reconciliation when an unsuccessful attempt is followed by another writer's registration", async () => {
      const h = harness();
      const { service, domains, provisioner } = h;
      provisioner.registerSendingDomain.mockRejectedValueOnce(new Error("socket hang up"));
      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      const [claim] = await service.list(workspaceId);
      expect(claim).toMatchObject({ registration: { status: "registering" } });

      h.advance(HOUR_MS);
      h.registerAtProvider("customer.test");

      await expectAppError(service.ensureRegistered(actor, workspaceId, "customer.test"), 409, "domain_needs_reconciliation");
      expect(await domains.findById(claim.id)).toMatchObject({ registrationStatus: "needs_reconciliation", providerDomainId: null });
      expect(provisioner.findByName).not.toHaveBeenCalled();
    });

    it("recovers a lost answer only through reconcile, which adopts the provider's registration and audits it", async () => {
      const h = harness();
      const { service, domains, provisioner, auditMetadata } = h;
      loseTheAnswer(h);

      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      const [claim] = [...domains.records.values()];
      expect(claim).toMatchObject({ workspaceId, domain: "customer.test", providerDomainId: null, registrationStatus: "registering" });

      expect(await service.add(actor, workspaceId, "customer.test")).toMatchObject({ registration: { status: "needs_reconciliation" } });
      expect(provisioner.findByName).not.toHaveBeenCalled();

      const reconciled = await service.reconcile(actor, workspaceId, claim.id);

      expect(provisioner.findByName).toHaveBeenCalledWith("customer.test");
      expect(reconciled).toMatchObject({
        id: claim?.id,
        registration: { status: "registered" },
        records: [expect.objectContaining({ purpose: "dkim" })],
      });
      expect(await domains.findById(claim.id)).toMatchObject({ providerDomainId: "provider-customer.test", providerRegion: "eu-west-1" });
      expect(domains.records.size).toBe(1);
      expect(auditMetadata("reconciled").map((event) => event.metadata)).toEqual([
        expect.objectContaining({ domainId: claim?.id, domain: "customer.test", outcome: "adopted", actorUserId: actor.userId }),
      ]);
      expect(auditMetadata("registered")).toEqual([]);

      expect((await service.ensureRegistered(actor, workspaceId, "customer.test")).ok).toBe(true);
      expect(await service.reconcile(actor, workspaceId, claim.id)).toEqual(reconciled);
      expect(provisioner.findByName).toHaveBeenCalledTimes(1);
    });

    it("waits for reconciliation when an attempt stopped before recording the registration it made", async () => {
      const { service, domains, providerDomains } = harness();
      vi.spyOn(domains, "recordRegistration").mockRejectedValueOnce(new Error("connection terminated"));

      await expect(service.ensureRegistered(actor, workspaceId, "customer.test")).rejects.toThrow("connection terminated");
      expect(providerDomains.has("customer.test")).toBe(true);

      await expectAppError(service.ensureRegistered(actor, workspaceId, "customer.test"), 409, "domain_needs_reconciliation");
      const [claim] = await service.list(workspaceId);
      expect(await service.reconcile(actor, workspaceId, claim.id)).toMatchObject({ registration: { status: "registered" } });
    });

    it("registers afresh on reconcile when the provider no longer holds the name", async () => {
      const h = harness();
      const { service, provisioner, providerDomains, auditMetadata } = h;
      h.registerAtProvider("customer.test");
      const view = await service.add(actor, workspaceId, "customer.test");
      providerDomains.delete("customer.test");

      const reconciled = await service.reconcile(actor, workspaceId, view.id);

      expect(reconciled).toMatchObject({ id: view.id, registration: { status: "registered" } });
      expect(provisioner.registerSendingDomain).toHaveBeenCalledTimes(2);
      expect(auditMetadata("reconciled").map((event) => event.metadata)).toEqual([
        expect.objectContaining({ domainId: view.id, outcome: "registered" }),
      ]);
    });

    it("refuses to reconcile a claim the provider has not reported, and a domain of another workspace", async () => {
      const { service, provisioner } = harness();
      provisioner.registerSendingDomain.mockRejectedValueOnce(new Error("socket hang up"));
      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      const [claim] = await service.list(workspaceId);

      await expectAppError(service.reconcile(actor, workspaceId, claim.id), 409, "domain_not_awaiting_reconciliation");
      await expectAppError(service.reconcile(actor, otherWorkspaceId, claim.id), 404, "not_found");
      expect(provisioner.findByName).not.toHaveBeenCalled();
    });

    it("reports a provider outage on reconcile and keeps the claim waiting", async () => {
      const h = harness();
      const { service, provisioner, domains } = h;
      h.registerAtProvider("customer.test");
      const view = await service.add(actor, workspaceId, "customer.test");
      provisioner.findByName.mockRejectedValueOnce(new Error("provider down"));

      await expectAppError(service.reconcile(actor, workspaceId, view.id), 502, "provider_unavailable");
      expect(await domains.findById(view.id)).toMatchObject({ registrationStatus: "needs_reconciliation", providerDomainId: null });
    });
  });

  describe("removal and cleanup", () => {
    it("revokes the domain first and leaves the provider cleanup to the sweep", async () => {
      const { service, domains, provisioner, mailboxes, auditMetadata, now } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test" });

      mailboxes.countActiveOnDomain.mockResolvedValueOnce(1);
      await expectAppError(service.remove(actor, workspaceId, domain.id), 409, "domain_has_mailboxes");
      expect((await domains.findById(domain.id))?.removedAt).toBeNull();

      await service.remove(actor, workspaceId, domain.id);
      expect(await domains.findById(domain.id)).toMatchObject({ removedAt: now(), providerCleanupStatus: "pending" });
      expect(await domains.findActiveByDomain("customer.test")).toBeNull();
      expect(provisioner.remove).not.toHaveBeenCalled();
      expect(auditMetadata("removed").map((event) => event.metadata)).toEqual([
        expect.objectContaining({ domainId: domain.id, haltedSendCount: 0 }),
      ]);
      await expectAppError(service.remove(actor, workspaceId, domain.id), 404, "not_found");

      expect(await service.cleanupRemoved(10)).toBe(1);
      expect(provisioner.remove).toHaveBeenCalledWith("provider-customer.test");
      expect((await domains.findById(domain.id))?.providerCleanupStatus).toBe("done");
      expect(await service.cleanupRemoved(10)).toBe(0);
    });

    it("retries a failed provider cleanup an hour later", async () => {
      const { service, domains, provisioner, logger, advance, now } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test" });
      await service.remove(actor, workspaceId, domain.id);

      provisioner.remove.mockRejectedValueOnce(new Error("provider down"));
      expect(await service.cleanupRemoved(10)).toBe(0);
      expect(await domains.findById(domain.id)).toMatchObject({
        providerCleanupStatus: "failed",
        nextCheckAt: new Date(now().getTime() + HOUR_MS),
      });
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ domainId: domain.id }), "email_domain_cleanup_failed");

      advance(30 * MINUTE_MS);
      expect(await service.cleanupRemoved(10)).toBe(0);
      advance(30 * MINUTE_MS);
      expect(await service.cleanupRemoved(10)).toBe(1);
      expect((await domains.findById(domain.id))?.providerCleanupStatus).toBe("done");
    });

    it("removes an unfinished claim without calling the provider, even while the provider is down", async () => {
      const { service, domains, provisioner, auditMetadata } = harness();
      provisioner.registerSendingDomain.mockRejectedValueOnce(new Error("socket hang up"));
      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      const [claim] = await service.list(workspaceId);
      for (const call of [provisioner.registerSendingDomain, provisioner.findByName, provisioner.remove]) {
        call.mockClear();
        call.mockRejectedValue(new Error("provider down"));
      }

      await service.remove(actor, workspaceId, claim.id);

      expect(await domains.findById(claim.id)).toMatchObject({ providerDomainId: null, providerCleanupStatus: "pending" });
      expect(await service.list(workspaceId)).toEqual([]);
      expect(auditMetadata("removed")).toHaveLength(1);
      expect(await service.cleanupRemoved(10)).toBe(1);
      expect((await domains.findById(claim.id))?.providerCleanupStatus).toBe("done");
      for (const call of [provisioner.registerSendingDomain, provisioner.findByName, provisioner.remove]) {
        expect(call).not.toHaveBeenCalled();
      }
    });

    it("leaves a lost answer's registration for reconciliation, since nothing ties it to the removed claim", async () => {
      const h = harness();
      const { service, provisioner, providerDomains } = h;
      provisioner.registerSendingDomain.mockImplementationOnce(async (domain) => {
        h.registerAtProvider(domain);
        throw new Error("socket hang up");
      });
      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      const [claim] = await service.list(workspaceId);
      await service.remove(actor, workspaceId, claim.id);
      await service.cleanupRemoved(10);

      expect(provisioner.remove).not.toHaveBeenCalled();
      expect(providerDomains.get("customer.test")).toBe("provider-customer.test");
      expect(await service.add(actor, otherWorkspaceId, "customer.test")).toMatchObject({ registration: { status: "needs_reconciliation" } });
    });

    it("hands a registration answered after its claim was removed to that claim's cleanup", async () => {
      const h = harness();
      const { service, domains, provisioner, providerDomains } = h;
      const answer = deferred<void>();
      provisioner.registerSendingDomain.mockImplementationOnce(async (domain) => {
        const providerDomainId = h.registerAtProvider(domain);
        await answer.promise;
        return { ok: true, providerDomainId, region: "eu-west-1", readiness: readiness("pending") };
      });
      const adding = service.add(actor, workspaceId, "customer.test");
      await vi.waitFor(() => expect(provisioner.registerSendingDomain).toHaveBeenCalled());
      const [claim] = await service.list(workspaceId);
      await service.remove(actor, workspaceId, claim.id);

      answer.resolve();
      await expectAppError(adding, 404, "not_found");

      expect(await domains.findById(claim.id)).toMatchObject({ providerDomainId: "provider-customer.test", providerCleanupStatus: "pending" });
      expect(await service.cleanupRemoved(10)).toBe(1);
      expect(provisioner.remove).toHaveBeenCalledWith("provider-customer.test");
      expect(providerDomains.size).toBe(0);
    });

    it("refuses to add a domain again until its removal has been cleaned up at the provider", async () => {
      const { service, domains, provisioner, advance } = harness();
      const first = await service.add(actor, workspaceId, "customer.test");
      await service.remove(actor, workspaceId, first.id);
      provisioner.registerSendingDomain.mockClear();

      await expectAppError(service.add(actor, otherWorkspaceId, "customer.test"), 409, "domain_removal_pending");
      await expectAppError(service.ensureRegistered(actor, workspaceId, "customer.test"), 409, "domain_removal_pending");
      provisioner.remove.mockRejectedValueOnce(new Error("provider down"));
      await service.cleanupRemoved(10);
      expect((await domains.findById(first.id))?.providerCleanupStatus).toBe("failed");
      await expectAppError(service.add(actor, otherWorkspaceId, "customer.test"), 409, "domain_removal_pending");
      expect(provisioner.registerSendingDomain).not.toHaveBeenCalled();
      expect(domains.records.size).toBe(1);

      advance(HOUR_MS);
      expect(await service.cleanupRemoved(10)).toBe(1);
      const readded = await service.add(actor, otherWorkspaceId, "customer.test");
      expect(readded).toMatchObject({ registration: { status: "registered" } });
      expect(await domains.findById(readded.id)).toMatchObject({ workspaceId: otherWorkspaceId, providerDomainId: "provider-customer.test#2" });
    });

    it("never lets a cleanup and a reconcile both act on one name: reconcile waits while the cleanup runs", async () => {
      const { service, domains, provisioner, providerDomains } = harness();
      const removed = await service.add(actor, workspaceId, "customer.test");
      await service.remove(actor, workspaceId, removed.id);
      // A claim taken while the removal committed: the provider still holds the removed domain's registration.
      const claim = domains.seed({ workspaceId: otherWorkspaceId, domain: "customer.test", providerDomainId: null, registrationStatus: "needs_reconciliation" });
      const deletion = deferred<void>();
      provisioner.remove.mockImplementationOnce(async (providerDomainId) => {
        await deletion.promise;
        providerDomains.delete("customer.test");
        expect(providerDomainId).toBe("provider-customer.test");
      });

      const cleaning = service.cleanupRemoved(10);
      await vi.waitFor(() => expect(provisioner.remove).toHaveBeenCalled());
      await expectAppError(service.reconcile(actor, otherWorkspaceId, claim.id), 409, "domain_removal_pending");
      expect(provisioner.findByName).not.toHaveBeenCalled();

      deletion.resolve();
      expect(await cleaning).toBe(1);
      const reconciled = await service.reconcile(actor, otherWorkspaceId, claim.id);
      expect(reconciled).toMatchObject({ registration: { status: "registered" } });
      expect(await domains.findById(claim.id)).toMatchObject({ providerDomainId: "provider-customer.test#2" });
    });

    it("never lets a reconcile adopt for a claim removed and cleaned up while its lookup ran", async () => {
      const h = harness();
      const { service, domains, provisioner } = h;
      h.registerAtProvider("customer.test");
      const view = await service.add(actor, workspaceId, "customer.test");
      const lookup = deferred<void>();
      const findByName = provisioner.findByName.getMockImplementation()!;
      provisioner.findByName.mockImplementationOnce(async (domain) => {
        await lookup.promise;
        return findByName(domain);
      });

      const reconciling = service.reconcile(actor, workspaceId, view.id);
      await vi.waitFor(() => expect(provisioner.findByName).toHaveBeenCalled());
      await service.remove(actor, workspaceId, view.id);
      expect(await service.cleanupRemoved(10)).toBe(1);

      lookup.resolve();
      await expectAppError(reconciling, 404, "not_found");
      expect(await domains.findById(view.id)).toMatchObject({ providerDomainId: null, providerCleanupStatus: "done" });
      expect(provisioner.remove).not.toHaveBeenCalled();
    });
  });

  describe("readiness refresh", () => {
    it("refreshes due domains on a cadence set by their readiness", async () => {
      const { service, provisioner, domains, advance, now } = harness();
      const registered = await service.ensureRegistered(actor, workspaceId, "customer.test");
      if (!registered.ok) throw new Error("not registered");

      expect(await service.refreshDue(10)).toBe(0);
      expect(provisioner.readiness).not.toHaveBeenCalled();

      advance(10 * MINUTE_MS);
      provisioner.readiness.mockResolvedValueOnce(readiness("pending"));
      expect(await service.refreshDue(10)).toBe(1);
      expect(provisioner.readiness).toHaveBeenCalledWith({ providerDomainId: "provider-customer.test", domain: "customer.test" });
      expect((await domains.findById(registered.domain.id))?.nextCheckAt?.getTime()).toBe(now().getTime() + 10 * MINUTE_MS);

      advance(10 * MINUTE_MS);
      provisioner.readiness.mockResolvedValueOnce(readiness("verified"));
      await service.refreshDue(10);
      expect((await domains.findById(registered.domain.id))?.nextCheckAt?.getTime()).toBe(now().getTime() + 24 * HOUR_MS);

      advance(24 * HOUR_MS);
      provisioner.readiness.mockResolvedValueOnce(readiness("failed"));
      await service.refreshDue(10);
      expect((await domains.findById(registered.domain.id))?.nextCheckAt?.getTime()).toBe(now().getTime() + 6 * HOUR_MS);
    });

    it("checks a domain with receiving pending on the pending cadence even when sending is verified", async () => {
      const { service, domains, provisioner, advance, now } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test", sendingStatus: "verified", nextCheckAt: now() });
      provisioner.readiness.mockResolvedValueOnce(readiness("verified", "pending"));
      advance(1);
      await service.refreshDue(10);
      expect((await domains.findById(domain.id))?.nextCheckAt?.getTime()).toBe(now().getTime() + 10 * MINUTE_MS);
    });

    it("defers a domain whose refresh failed at the provider without changing its readiness", async () => {
      const { service, domains, provisioner, logger, advance, now, audit } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test", sendingStatus: "verified", nextCheckAt: now() });
      provisioner.readiness.mockRejectedValueOnce(new Error("provider down"));
      advance(1);
      expect(await service.refreshDue(10)).toBe(0);
      expect(await domains.findById(domain.id)).toMatchObject({ sendingStatus: "verified" });
      expect((await domains.findById(domain.id))?.nextCheckAt?.getTime()).toBe(now().getTime() + 10 * MINUTE_MS);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ domainId: domain.id }), "email_domain_refresh_failed");
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("keeps a provider event that arrives during a refresh, so a revoked domain is read on the next sweep", async () => {
      const { service, domains, provisioner, logger, advance, now } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test", sendingStatus: "verified", nextCheckAt: now() });
      advance(1);
      // The refresh reads the provider before the revocation; the provider's event arrives before it records.
      const read = deferred<DomainReadiness>();
      provisioner.readiness.mockImplementationOnce(() => read.promise);
      const refreshing = service.refreshDue(10);
      await vi.waitFor(() => expect(provisioner.readiness).toHaveBeenCalled());
      expect(await domains.expediteRefresh({ provider: "local", providerDomainId: "provider-customer.test" })).toBe(true);
      read.resolve(readiness("verified"));
      expect(await refreshing).toBe(0);
      expect((await domains.findById(domain.id))?.nextCheckAt?.getTime()).toBeLessThanOrEqual(now().getTime());

      provisioner.readiness.mockResolvedValueOnce(readiness("failed"));
      expect(await service.refreshDue(10)).toBe(1);
      expect(await domains.findById(domain.id)).toMatchObject({ sendingStatus: "failed" });
      expect(logger.warn).toHaveBeenCalledWith({ domainId: domain.id, to: "failed" }, "email_domain_readiness_lost");
    });

    it("keeps a provider event that arrives during a failed refresh due at once rather than deferred", async () => {
      const { service, domains, provisioner, advance, now } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test", sendingStatus: "verified", nextCheckAt: now() });
      advance(1);
      const read = deferred<DomainReadiness>();
      provisioner.readiness.mockImplementationOnce(() => read.promise);
      const refreshing = service.refreshDue(10);
      await vi.waitFor(() => expect(provisioner.readiness).toHaveBeenCalled());
      await domains.expediteRefresh({ provider: "local", providerDomainId: "provider-customer.test" });
      read.reject(new Error("provider down"));
      expect(await refreshing).toBe(0);
      expect((await domains.findById(domain.id))?.nextCheckAt?.getTime()).toBeLessThanOrEqual(now().getTime());
    });

    it("verifies on request: asks the provider to check, then records the readiness it reads back", async () => {
      const { service, domains, provisioner, now } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test", nextCheckAt: now() });
      provisioner.readiness.mockResolvedValueOnce(readiness("verified"));
      const view = await service.verify(actor, workspaceId, domain.id);
      expect(provisioner.requestVerification).toHaveBeenCalledWith("provider-customer.test");
      expect(provisioner.requestVerification.mock.invocationCallOrder[0]).toBeLessThan(provisioner.readiness.mock.invocationCallOrder[0] ?? 0);
      expect(view.sending).toEqual({ status: "verified", checkedAt: now().toISOString() });

      await expectAppError(service.verify(actor, otherWorkspaceId, domain.id), 404, "not_found");
      provisioner.requestVerification.mockRejectedValueOnce(new Error("provider down"));
      await expectAppError(service.verify(actor, workspaceId, domain.id), 502, "provider_unavailable");
    });

    it("finishes an unfinished registration when the operator checks the domain", async () => {
      const { service, provisioner } = harness();
      provisioner.registerSendingDomain.mockRejectedValueOnce(new Error("socket hang up"));
      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      const [pending] = await service.list(workspaceId);
      expect(pending).toMatchObject({ domain: "customer.test", registration: { status: "registering" }, records: [] });

      const view = await service.verify(actor, workspaceId, pending.id);

      expect(view).toMatchObject({ id: pending?.id, registration: { status: "registered" }, records: [expect.objectContaining({ purpose: "dkim" })] });
      expect(provisioner.requestVerification).toHaveBeenCalledWith("provider-customer.test");
    });
  });

  describe("readiness audit", () => {
    it("audits each capability transition, counts it, and warns when sending readiness is lost", async () => {
      const { service, domains, provisioner, auditMetadata, metrics, logger, advance, now } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test", nextCheckAt: now() });

      provisioner.readiness.mockResolvedValueOnce(readiness("verified"));
      advance(1);
      await service.refreshDue(10);
      expect(auditMetadata("readiness_changed").map((event) => event.metadata)).toEqual([
        expect.objectContaining({ domainId: domain.id, capability: "sending", from: "pending", to: "verified" }),
      ]);
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        "email_domain_readiness_transitions_total",
        expect.objectContaining({ labels: { capability: "sending", to: "verified" } }),
      );

      provisioner.readiness.mockResolvedValueOnce(readiness("verified"));
      advance(24 * HOUR_MS);
      await service.refreshDue(10);
      expect(auditMetadata("readiness_changed")).toHaveLength(1);
      expect(logger.warn).not.toHaveBeenCalled();

      provisioner.readiness.mockResolvedValueOnce(readiness("failed"));
      advance(24 * HOUR_MS);
      await service.refreshDue(10);
      expect(auditMetadata("readiness_changed").map((event) => event.metadata)).toEqual([
        expect.objectContaining({ capability: "sending", from: "pending", to: "verified" }),
        expect.objectContaining({ capability: "sending", from: "verified", to: "failed" }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith({ domainId: domain.id, to: "failed" }, "email_domain_readiness_lost");
      expect(JSON.stringify(auditMetadata("readiness_changed"))).not.toContain("p=abc");
    });
  });

  describe("direct receiving", () => {
    it("requires the operator to type the domain before enabling receiving at the provider", async () => {
      const { service, domains, provisioner, auditMetadata, now } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test", sendingStatus: "verified", nextCheckAt: now() });

      await expectAppError(service.enableReceiving(actor, workspaceId, domain.id, "customer.tes"), 400, "confirmation_mismatch");
      await expectAppError(service.enableReceiving(actor, workspaceId, domain.id, ""), 400, "confirmation_mismatch");
      expect(provisioner.enableReceiving).not.toHaveBeenCalled();

      const view = await service.enableReceiving(actor, workspaceId, domain.id, "  Customer.TEST ");
      expect(provisioner.enableReceiving).toHaveBeenCalledWith("provider-customer.test");
      expect(view.receiving.status).toBe("pending");
      expect(await domains.findById(domain.id)).toMatchObject({ receivingConfirmedByUserId: actor.userId, receivingStatus: "pending" });
      expect(auditMetadata("receiving_enabled").map((event) => event.metadata)).toEqual([
        expect.objectContaining({ domainId: domain.id, confirmedByUserId: actor.userId }),
      ]);
      expect(auditMetadata("readiness_changed").map((event) => event.metadata)).toEqual([
        expect.objectContaining({ capability: "receiving", from: "not_requested", to: "pending" }),
      ]);
      await expectAppError(service.enableReceiving(actor, otherWorkspaceId, domain.id, "customer.test"), 404, "not_found");
    });

    it("keeps a provider event that arrives while receiving is enabled due for the next sweep", async () => {
      const { service, domains, provisioner, now } = harness();
      const domain = domains.seed({ workspaceId, domain: "customer.test", sendingStatus: "verified", nextCheckAt: new Date(now().getTime() + HOUR_MS) });
      provisioner.enableReceiving.mockImplementationOnce(async () => {
        await domains.expediteRefresh({ provider: "local", providerDomainId: "provider-customer.test" });
        return readiness("verified", "pending");
      });

      await service.enableReceiving(actor, workspaceId, domain.id, "customer.test");

      expect(await domains.findById(domain.id)).toMatchObject({ receivingConfirmedByUserId: actor.userId, receivingStatus: "pending" });
      expect((await domains.findById(domain.id))?.nextCheckAt?.getTime()).toBeLessThanOrEqual(now().getTime());
    });
  });
});
