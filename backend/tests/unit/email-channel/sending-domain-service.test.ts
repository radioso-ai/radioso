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

const harness = () => {
  let now = new Date("2026-10-03T12:00:00.000Z");
  const clock = () => now;
  const domains = new InMemoryEmailDomains(clock);
  // The provider account: one registration per name, as Resend keeps them, with when it was created.
  const providerDomains = new Map<string, Date>();
  const providerDomainOf = (domain: string, createdAt: Date) => ({
    providerDomainId: `provider-${domain}`,
    region: "eu-west-1",
    readiness: readiness("pending"),
    createdAt,
  });
  const provisioner = {
    provider: "local",
    registerSendingDomain: vi.fn<EmailDomainProvisioner["registerSendingDomain"]>(async (domain) => {
      if (providerDomains.has(domain)) return { ok: false, refused: "already_registered" };
      providerDomains.set(domain, now);
      return { ok: true, ...providerDomainOf(domain, now) };
    }),
    findByName: vi.fn<EmailDomainProvisioner["findByName"]>(async (domain) => {
      const createdAt = providerDomains.get(domain);
      return createdAt ? providerDomainOf(domain, createdAt) : null;
    }),
    enableReceiving: vi.fn<EmailDomainProvisioner["enableReceiving"]>(async () => readiness("verified", "pending")),
    requestVerification: vi.fn<EmailDomainProvisioner["requestVerification"]>(async () => undefined),
    readiness: vi.fn<EmailDomainProvisioner["readiness"]>(async () => readiness("pending")),
    remove: vi.fn<EmailDomainProvisioner["remove"]>(async (providerDomainId) => {
      providerDomains.delete(providerDomainId.replace(/^provider-/u, ""));
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

    it("gives the same refusal when the provider holds the name outside this deployment, keeping no claim", async () => {
      const { service, provisioner, domains } = harness();
      provisioner.registerSendingDomain.mockResolvedValueOnce({ ok: false, refused: "already_registered" });
      expect(await service.ensureRegistered(actor, workspaceId, "customer.test")).toEqual({ ok: false, refused: "claimed_elsewhere" });
      expect(provisioner.findByName).toHaveBeenCalledWith("customer.test");
      expect(domains.records.size).toBe(0);
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

  describe("recovering an interrupted registration", () => {
    const loseTheAnswer = (h: ReturnType<typeof harness>) => {
      h.provisioner.registerSendingDomain.mockImplementationOnce(async (domain) => {
        h.providerDomains.set(domain, h.now());
        throw new Error("socket hang up");
      });
    };

    it("adopts the provider's registration on retry when the create was accepted but its answer was lost", async () => {
      const h = harness();
      const { service, domains, provisioner, auditMetadata, logger } = h;
      loseTheAnswer(h);

      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      const [claim] = [...domains.records.values()];
      expect(claim).toMatchObject({ workspaceId, domain: "customer.test", providerDomainId: null, nextCheckAt: null });

      const retried = await service.ensureRegistered(actor, workspaceId, "customer.test");

      expect(retried).toEqual({
        ok: true,
        domain: expect.objectContaining({
          id: claim?.id,
          providerDomainId: "provider-customer.test",
          providerRegion: "eu-west-1",
          sendingStatus: "pending",
        }),
      });
      expect(provisioner.findByName).toHaveBeenCalledWith("customer.test");
      expect(domains.records.size).toBe(1);
      expect(auditMetadata("registered").map((event) => event.metadata)).toEqual([
        expect.objectContaining({ domainId: claim?.id, recovered: true }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith({ domainId: claim?.id }, "email_domain_registration_recovered");
    });

    it("adopts the provider's registration when the earlier attempt stopped before recording it", async () => {
      const { service, domains, provisioner, providerDomains } = harness();
      vi.spyOn(domains, "recordRegistration").mockRejectedValueOnce(new Error("connection terminated"));

      await expect(service.ensureRegistered(actor, workspaceId, "customer.test")).rejects.toThrow("connection terminated");
      expect(providerDomains.has("customer.test")).toBe(true);

      const retried = await service.ensureRegistered(actor, workspaceId, "customer.test");

      expect(retried).toMatchObject({ ok: true, domain: { workspaceId, providerDomainId: "provider-customer.test" } });
      expect(provisioner.registerSendingDomain).toHaveBeenCalledTimes(2);
      expect(domains.records.size).toBe(1);
    });

    it("still refuses a second workspace while the first holds the claim, finished or not", async () => {
      const h = harness();
      const { service, provisioner } = h;
      loseTheAnswer(h);
      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      provisioner.registerSendingDomain.mockClear();

      expect(await service.ensureRegistered(actor, otherWorkspaceId, "customer.test")).toEqual({ ok: false, refused: "claimed_elsewhere" });
      expect(provisioner.registerSendingDomain).not.toHaveBeenCalled();
      expect(provisioner.findByName).not.toHaveBeenCalled();

      expect((await service.ensureRegistered(actor, workspaceId, "customer.test")).ok).toBe(true);
      expect(await service.ensureRegistered(actor, otherWorkspaceId, "customer.test")).toEqual({ ok: false, refused: "claimed_elsewhere" });
    });

    it("finishes an unfinished registration when the operator checks the domain", async () => {
      const h = harness();
      const { service, provisioner } = h;
      loseTheAnswer(h);
      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      const [pending] = await service.list(workspaceId);
      expect(pending).toMatchObject({ domain: "customer.test", sending: { status: "pending" }, records: [] });

      const view = await service.verify(actor, workspaceId, pending.id);

      expect(view).toMatchObject({ id: pending.id, records: [expect.objectContaining({ purpose: "dkim" })] });
      expect(provisioner.requestVerification).toHaveBeenCalledWith("provider-customer.test");
    });

    it("records a fresh registration even when the provider does not say when it created it", async () => {
      const { service, provisioner } = harness();
      provisioner.registerSendingDomain.mockResolvedValueOnce({
        ok: true,
        providerDomainId: "provider-customer.test",
        region: null,
        readiness: readiness("pending"),
        createdAt: null,
      });

      expect(await service.ensureRegistered(actor, workspaceId, "customer.test")).toMatchObject({
        ok: true,
        domain: { providerDomainId: "provider-customer.test" },
      });
    });

    it("never adopts a registration the provider account held before the claim", async () => {
      const { service, domains, providerDomains, advance, now } = harness();
      // Registered on the account by operations, or by another deployment sharing it.
      providerDomains.set("customer.test", now());
      advance(10 * MINUTE_MS);

      expect(await service.ensureRegistered(actor, workspaceId, "customer.test")).toEqual({ ok: false, refused: "claimed_elsewhere" });
      expect(domains.records.size).toBe(0);
    });

    it("records an unfinished claim's provider registration before removing it, so the cleanup removes that too", async () => {
      const h = harness();
      const { service, domains, provisioner, providerDomains } = h;
      loseTheAnswer(h);
      await expectAppError(service.add(actor, workspaceId, "customer.test"), 502, "provider_unavailable");
      const [pending] = await service.list(workspaceId);

      await service.remove(actor, workspaceId, pending.id);

      expect(await domains.findById(pending.id)).toMatchObject({ providerDomainId: "provider-customer.test", providerCleanupStatus: "pending" });
      expect(await service.cleanupRemoved(10)).toBe(1);
      expect(provisioner.remove).toHaveBeenCalledWith("provider-customer.test");
      expect(providerDomains.size).toBe(0);
      expect((await service.ensureRegistered(actor, otherWorkspaceId, "customer.test")).ok).toBe(true);
    });

    it("keeps a removed domain's provider registration once a new registration adopted it", async () => {
      const { service, domains, provisioner } = harness();
      const first = await service.ensureRegistered(actor, workspaceId, "customer.test");
      if (!first.ok) throw new Error("not registered");
      await service.remove(actor, workspaceId, first.domain.id);

      const readded = await service.ensureRegistered(actor, otherWorkspaceId, "customer.test");
      expect(readded).toMatchObject({ ok: true, domain: { workspaceId: otherWorkspaceId, providerDomainId: "provider-customer.test" } });

      expect(await service.cleanupRemoved(10)).toBe(1);
      expect(provisioner.remove).not.toHaveBeenCalled();
      expect((await domains.findById(first.domain.id))?.providerCleanupStatus).toBe("done");
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
  });

  describe("removal", () => {
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
  });
});
