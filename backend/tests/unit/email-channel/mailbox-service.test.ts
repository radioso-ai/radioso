import { describe, expect, it, vi } from "vitest";

import type { AuditEventInput } from "../../../src/modules/audit/contracts/index.js";
import { emailMailboxPolicyRef, MailboxService, type EngagementMode } from "../../../src/modules/emailChannel/public.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes, inMemoryPolicyChanges } from "../../support/inMemoryEmailChannel.js";

const HOUR_MS = 60 * 60 * 1000;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "44444444-4444-4444-8444-444444444444";
const foreignAgentId = "55555555-5555-4555-8555-555555555555";
const actor = { userId: "33333333-3333-4333-8333-333333333333", accountId: null };

const harness = (supportedModes: readonly EngagementMode[] = ["operator_only"]) => {
  let now = new Date("2026-10-03T12:00:00.000Z");
  const clock = () => now;
  const domains = new InMemoryEmailDomains(clock);
  const mailboxes = new InMemoryEmailMailboxes(clock);
  const policyChanges = inMemoryPolicyChanges(mailboxes);
  const sendingDomains = {
    ensureRegistered: vi.fn(async (_actor: unknown, ws: string, domain: string) => {
      const existing = await domains.findActiveByDomain(domain);
      if (existing && existing.workspaceId !== ws) return { ok: false as const, refused: "claimed_elsewhere" as const };
      return { ok: true as const, domain: existing ?? domains.seed({ workspaceId: ws, domain }) };
    }),
  };
  const agents = {
    findByIdAndWorkspaceId: vi.fn(async (id: string, ws: string) =>
      (id === agentId && ws === workspaceId) || (id === foreignAgentId && ws === otherWorkspaceId) ? { id } : null),
  };
  const audit = { record: vi.fn(async (_event: AuditEventInput) => undefined) };
  let draw = 0;
  const randomBytes = (size: number) => {
    draw += 1;
    return Uint8Array.from({ length: size }, (_, index) => (draw * 37 + index * 11) & 255);
  };
  const service = new MailboxService({
    mailboxes,
    domainRecords: domains,
    sendingDomains,
    policyChanges,
    agents,
    audit,
    logger: { warn: vi.fn() },
    randomBytes,
    clock,
    config: { inboundDomain: "in.radioso.test", supportedModes },
  });
  const audits = () => audit.record.mock.calls.map(([event]) => ({ ...event, metadata: event.metadata ?? {} }));
  return {
    service,
    domains,
    mailboxes,
    policyChanges,
    sendingDomains,
    audits,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
};

const expectAppError = async (work: Promise<unknown>, statusCode: number, code: string): Promise<void> => {
  const error = await work.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode, code });
};

const createSupport = (service: MailboxService, overrides: Record<string, unknown> = {}) =>
  service.create(actor, workspaceId, { address: "support@customer.test", displayName: "Support", ...overrides });

describe("MailboxService", () => {
  describe("create", () => {
    it("registers the address's domain, issues a relay token, writes policy version 1 and applies defaults", async () => {
      const { service, domains, mailboxes, sendingDomains, audits } = harness();
      const view = await service.create(actor, workspaceId, {
        address: "  Support@Customer.TEST ",
        displayName: " Support ",
        agentId,
      });

      expect(sendingDomains.ensureRegistered).toHaveBeenCalledWith(actor, workspaceId, "customer.test");
      const [domain] = await domains.listActive(workspaceId);
      expect(view).toMatchObject({
        address: "support@customer.test",
        displayName: "Support",
        agentId,
        domainId: domain?.id,
        engagementMode: "operator_only",
        enabled: true,
        policyVersion: 1,
        threadSendBudget: 3,
        hourlyGenerationBudget: 30,
        threadContextMessages: 10,
        spamOptIn: false,
        silenceThresholdHours: 72,
        receiving: { state: "waiting_for_first_message", lastReceivedAt: null },
        sending: { state: "not_verified" },
        plusAddressVerified: false,
        setupCheck: null,
      });
      expect(view.address.split("@")[1]).toBe(domain?.domain);
      expect(view.relayAddress).toMatch(/^[a-z2-7]{26}@in\.radioso\.test$/);
      const stored = mailboxes.records.get(view.id);
      expect(stored?.relayToken).toBe(view.relayAddress.split("@")[0]?.toUpperCase());
      expect(mailboxes.history).toEqual([
        expect.objectContaining({ mailboxId: view.id, version: 1, engagementMode: "operator_only", enabled: true, agentId }),
      ]);
      expect(audits()).toEqual([
        expect.objectContaining({
          eventType: "email_channel.mailbox",
          workspaceId,
          metadata: expect.objectContaining({ action: "created", mailboxId: view.id, domainId: domain?.id, agentId, mode: "operator_only" }),
        }),
      ]);
      expect(JSON.stringify(audits())).not.toContain(stored?.relayToken);
    });

    it("issues a distinct relay token per mailbox", async () => {
      const { service } = harness();
      const support = await createSupport(service);
      const sales = await createSupport(service, { address: "sales@customer.test" });
      expect(support.relayAddress).not.toBe(sales.relayAddress);
    });

    it("applies requested settings within their bounds and refuses values outside them", async () => {
      const { service } = harness();
      const view = await createSupport(service, { threadSendBudget: 20, hourlyGenerationBudget: 1, spamOptIn: true, silenceThresholdHours: 2160 });
      expect(view).toMatchObject({ threadSendBudget: 20, hourlyGenerationBudget: 1, spamOptIn: true, silenceThresholdHours: 2160 });
      await expectAppError(createSupport(service, { address: "a@customer.test", threadSendBudget: 21 }), 400, "bad_request");
      await expectAppError(createSupport(service, { address: "b@customer.test", threadContextMessages: 0 }), 400, "bad_request");
      await expectAppError(createSupport(service, { address: "c@customer.test", displayName: "  " }), 400, "bad_request");
    });

    it("refuses an invalid address before registering anything", async () => {
      const { service, sendingDomains } = harness();
      for (const address of ["support", "@customer.test", "support+tag@customer.test", "two words@customer.test", "support@not a domain"]) {
        await expectAppError(createSupport(service, { address }), 400, "invalid_address");
      }
      expect(sendingDomains.ensureRegistered).not.toHaveBeenCalled();
    });

    it("maps the domain refusals and a duplicate address to their errors", async () => {
      const { service, sendingDomains } = harness();
      sendingDomains.ensureRegistered.mockResolvedValueOnce({ ok: false, refused: "claimed_elsewhere" });
      await expectAppError(createSupport(service), 409, "domain_claimed_elsewhere");
      sendingDomains.ensureRegistered.mockResolvedValueOnce({ ok: false, refused: "invalid_domain" } as never);
      await expectAppError(createSupport(service), 400, "invalid_address");

      await createSupport(service);
      await expectAppError(createSupport(service), 409, "mailbox_exists");
    });

    it("refuses an agent from another workspace", async () => {
      const { service, mailboxes } = harness();
      await expectAppError(createSupport(service, { agentId: foreignAgentId }), 400, "bad_request");
      expect(mailboxes.records.size).toBe(0);
    });
  });

  describe("supportedModes gating", () => {
    it("defaults to operator_only while draft is unsupported, and to draft once it is", async () => {
      expect(harness(["operator_only"]).service.modes()).toEqual({ supportedModes: ["operator_only"], defaultMode: "operator_only" });
      const withDraft = harness(["operator_only", "draft"]);
      expect(withDraft.service.modes()).toEqual({ supportedModes: ["operator_only", "draft"], defaultMode: "draft" });
      expect((await createSupport(withDraft.service)).engagementMode).toBe("draft");
    });

    it("refuses an unsupported mode on create with 409 engagement_mode_unavailable and writes nothing", async () => {
      const { service, sendingDomains, mailboxes } = harness();
      await expectAppError(createSupport(service, { engagementMode: "draft" }), 409, "engagement_mode_unavailable");
      await expectAppError(createSupport(service, { engagementMode: "auto" }), 409, "engagement_mode_unavailable");
      expect(sendingDomains.ensureRegistered).not.toHaveBeenCalled();
      expect(mailboxes.records.size).toBe(0);
    });

    it("refuses a change to an unsupported mode without bumping the policy version", async () => {
      const { service, mailboxes } = harness();
      const created = await createSupport(service);
      await expectAppError(service.update(actor, workspaceId, created.id, { engagementMode: "auto" }), 409, "engagement_mode_unavailable");
      expect(mailboxes.records.get(created.id)?.policyVersion).toBe(1);
      expect(mailboxes.history).toHaveLength(1);
    });
  });

  describe("draft mode (S3)", () => {
    const DRAFTING: readonly EngagementMode[] = ["operator_only", "draft"];

    it("offers draft once the deployment supports it, and makes it the default for new mailboxes", async () => {
      const { service } = harness(DRAFTING);

      expect(service.modes()).toEqual({ supportedModes: ["operator_only", "draft"], defaultMode: "draft" });
      expect(await createSupport(service)).toMatchObject({ engagementMode: "draft", policyVersion: 1 });
      expect(await createSupport(service, { address: "sales@customer.test", engagementMode: "operator_only" }))
        .toMatchObject({ engagementMode: "operator_only" });
    });

    it("does not upgrade a mailbox created before draft was supported", async () => {
      const before = harness(["operator_only"]);
      const created = await createSupport(before.service);
      const after = new MailboxService({
        mailboxes: before.mailboxes,
        domainRecords: before.domains,
        sendingDomains: before.sendingDomains,
        policyChanges: before.policyChanges,
        agents: { findByIdAndWorkspaceId: vi.fn(async () => null) },
        audit: { record: vi.fn(async () => undefined) },
        logger: { warn: vi.fn() },
        randomBytes: (size) => new Uint8Array(size),
        clock: before.now,
        config: { inboundDomain: "in.radioso.test", supportedModes: DRAFTING },
      });

      expect(await after.get(workspaceId, created.id)).toMatchObject({ engagementMode: "operator_only", policyVersion: 1 });
      expect(await after.update(actor, workspaceId, created.id, { displayName: "Help desk" })).toMatchObject({ engagementMode: "operator_only" });
      expect(before.mailboxes.history.map((policy) => policy.engagementMode)).toEqual(["operator_only"]);
    });

    it("supersedes the drafts bound to the mailbox's policy when a downgrade bumps it, in the same unit, and audits the count", async () => {
      const { service, policyChanges, mailboxes, audits } = harness(DRAFTING);
      const created = await createSupport(service);
      vi.spyOn(policyChanges.heldReplies, "supersedePendingForPolicy").mockImplementation(async (policyRef) => {
        policyChanges.heldReplies.superseded.push(policyRef);
        // Inside the policy change: the new version is already written.
        expect(mailboxes.records.get(created.id)?.policyVersion).toBe(2);
        return 2;
      });

      const downgraded = await service.update(actor, workspaceId, created.id, { engagementMode: "operator_only", expectedPolicyVersion: 1 });

      expect(downgraded).toMatchObject({ engagementMode: "operator_only", policyVersion: 2 });
      expect(policyChanges.runs).toBe(1);
      expect(policyChanges.heldReplies.superseded).toEqual([emailMailboxPolicyRef(created.id)]);
      expect(audits().filter((event) => event.metadata.action === "mode_changed").at(-1)?.metadata)
        .toMatchObject({ fromMode: "draft", toMode: "operator_only", policyVersion: 2, supersededHeldReplies: 2 });
    });

    it("supersedes nothing when only settings change", async () => {
      const { service, policyChanges } = harness(DRAFTING);
      const created = await createSupport(service);

      await service.update(actor, workspaceId, created.id, { threadContextMessages: 5 });

      expect(policyChanges.heldReplies.superseded).toEqual([]);
    });
  });

  describe("auto mode (S6)", () => {
    const ALL_MODES: readonly EngagementMode[] = ["operator_only", "draft", "auto"];

    it("offers auto once the deployment supports it, and keeps draft the default for new mailboxes", async () => {
      const { service } = harness(ALL_MODES);

      expect(service.modes()).toEqual({ supportedModes: ["operator_only", "draft", "auto"], defaultMode: "draft" });
      expect(await createSupport(service)).toMatchObject({ engagementMode: "draft" });
    });

    it("refuses a switch to auto without the explicit opt-in, with 400 auto_opt_in_required, and writes nothing", async () => {
      const { service, mailboxes, policyChanges } = harness(ALL_MODES);
      const created = await createSupport(service);

      await expectAppError(service.update(actor, workspaceId, created.id, { engagementMode: "auto" }), 400, "auto_opt_in_required");
      await expectAppError(service.update(actor, workspaceId, created.id, { engagementMode: "auto", autoOptIn: false }), 400, "auto_opt_in_required");

      expect(mailboxes.records.get(created.id)).toMatchObject({ engagementMode: "draft", policyVersion: 1 });
      expect(mailboxes.history).toHaveLength(1);
      expect(policyChanges.heldReplies.superseded).toEqual([]);
    });

    it("switches to auto with the opt-in as a new policy version, and audits the change", async () => {
      const { service, mailboxes, audits } = harness(ALL_MODES);
      const created = await createSupport(service);

      const switched = await service.update(actor, workspaceId, created.id, { engagementMode: "auto", autoOptIn: true, expectedPolicyVersion: 1 });

      expect(switched).toMatchObject({ engagementMode: "auto", policyVersion: 2 });
      expect(mailboxes.history.map((policy) => policy.engagementMode)).toEqual(["draft", "auto"]);
      expect(audits().filter((event) => event.metadata.action === "mode_changed").at(-1)?.metadata)
        .toMatchObject({ fromMode: "draft", toMode: "auto", policyVersion: 2 });
    });

    it("asks for no opt-in once a mailbox is auto, or to leave auto", async () => {
      const { service } = harness(ALL_MODES);
      const created = await createSupport(service, { engagementMode: "auto", autoOptIn: true });

      expect(await service.update(actor, workspaceId, created.id, { engagementMode: "auto", threadSendBudget: 2 }))
        .toMatchObject({ engagementMode: "auto", threadSendBudget: 2, policyVersion: 1 });
      expect(await service.update(actor, workspaceId, created.id, { engagementMode: "draft" }))
        .toMatchObject({ engagementMode: "draft", policyVersion: 2 });
    });

    it("creates an auto mailbox only with the opt-in", async () => {
      const { service, sendingDomains, mailboxes } = harness(ALL_MODES);

      await expectAppError(createSupport(service, { engagementMode: "auto" }), 400, "auto_opt_in_required");
      expect(sendingDomains.ensureRegistered).not.toHaveBeenCalled();
      expect(mailboxes.records.size).toBe(0);

      expect(await createSupport(service, { engagementMode: "auto", autoOptIn: true })).toMatchObject({ engagementMode: "auto", policyVersion: 1 });
    });

    it("holds unsent automatic replies for review when auto drops to draft: re-bound to the new version, nothing superseded (FR-025)", async () => {
      const { service, policyChanges, mailboxes, audits } = harness(ALL_MODES);
      const created = await createSupport(service, { engagementMode: "auto", autoOptIn: true });
      vi.spyOn(policyChanges.heldReplies, "holdLiveForPolicy").mockImplementation(async (policyRef, policyVersion) => {
        policyChanges.heldReplies.held.push({ policyRef, policyVersion });
        // Inside the policy change: the new version is already written.
        expect(mailboxes.records.get(created.id)?.policyVersion).toBe(2);
        return { returned: 2, rebound: 1 };
      });

      const downgraded = await service.update(actor, workspaceId, created.id, { engagementMode: "draft", expectedPolicyVersion: 1 });

      expect(downgraded).toMatchObject({ engagementMode: "draft", policyVersion: 2 });
      expect(policyChanges.runs).toBe(1);
      expect(policyChanges.heldReplies.held).toEqual([{ policyRef: emailMailboxPolicyRef(created.id), policyVersion: 2 }]);
      expect(policyChanges.heldReplies.superseded).toEqual([]);
      expect(audits().filter((event) => event.metadata.action === "mode_changed").at(-1)?.metadata).toMatchObject({
        fromMode: "auto",
        toMode: "draft",
        policyVersion: 2,
        supersededHeldReplies: 0,
        returnedHeldReplies: 2,
        reboundHeldReplies: 1,
      });
    });

    it.each([
      ["auto drops to operator_only", "auto", { engagementMode: "operator_only" }],
      ["auto drops to draft as the mailbox is disabled", "auto", { engagementMode: "draft", enabled: false }],
      ["auto drops to draft under a new agent", "auto", { engagementMode: "draft", agentId }],
      ["an auto mailbox is disabled", "auto", { enabled: false }],
      ["an auto mailbox changes its agent", "auto", { agentId }],
      ["draft drops to operator_only", "draft", { engagementMode: "operator_only" }],
      ["draft is upgraded to auto", "draft", { engagementMode: "auto", autoOptIn: true }],
      ["operator_only is upgraded to auto", "operator_only", { engagementMode: "auto", autoOptIn: true }],
      ["operator_only is upgraded to draft", "operator_only", { engagementMode: "draft" }],
    ] as const)("supersedes the live drafts, holding none, when %s", async (_label, mode, change) => {
      const { service, policyChanges } = harness(ALL_MODES);
      const created = await createSupport(service, { engagementMode: mode, autoOptIn: mode === "auto" });

      await service.update(actor, workspaceId, created.id, change);

      expect(policyChanges.heldReplies.superseded).toEqual([emailMailboxPolicyRef(created.id)]);
      expect(policyChanges.heldReplies.held).toEqual([]);
    });

    it("still refuses auto where the deployment does not run it, opt-in or not", async () => {
      const { service, mailboxes } = harness(["operator_only", "draft"]);
      const created = await createSupport(service);

      await expectAppError(service.update(actor, workspaceId, created.id, { engagementMode: "auto", autoOptIn: true }), 409, "engagement_mode_unavailable");
      expect(mailboxes.records.get(created.id)?.policyVersion).toBe(1);
    });
  });

  describe("policy changes", () => {
    it("changes enabled, mode and agent through the policy-change port with a new version and history row", async () => {
      const { service, mailboxes, policyChanges, audits } = harness(["operator_only", "draft"]);
      const created = await createSupport(service, { engagementMode: "operator_only" });
      mailboxes.calls.length = 0;

      const disabled = await service.update(actor, workspaceId, created.id, { enabled: false, expectedPolicyVersion: 1 });
      expect(policyChanges.runs).toBe(1);
      expect(mailboxes.calls).toEqual(["lockForPolicyChange", "appendPolicyVersion"]);
      expect(disabled).toMatchObject({ enabled: false, policyVersion: 2 });

      const drafting = await service.update(actor, workspaceId, created.id, { engagementMode: "draft", agentId });
      expect(drafting).toMatchObject({ engagementMode: "draft", agentId, policyVersion: 3 });
      expect(mailboxes.history.map((policy) => [policy.version, policy.engagementMode, policy.enabled, policy.agentId, policy.changedByUserId]))
        .toEqual([
          [1, "operator_only", true, null, actor.userId],
          [2, "operator_only", false, null, actor.userId],
          [3, "draft", false, agentId, actor.userId],
        ]);

      const modeChanges = audits().filter((event) => event.metadata.action === "mode_changed").map((event) => event.metadata);
      expect(modeChanges).toEqual([
        expect.objectContaining({ mailboxId: created.id, fromMode: "operator_only", toMode: "operator_only", enabled: false, policyVersion: 2, supersededHeldReplies: 0 }),
        expect.objectContaining({ mailboxId: created.id, fromMode: "operator_only", toMode: "draft", enabled: false, policyVersion: 3 }),
      ]);
      const updates = audits().filter((event) => event.metadata.action === "updated").map((event) => event.metadata);
      expect(updates).toEqual([expect.objectContaining({ mailboxId: created.id, changedFields: ["agentId"], policyVersion: 3 })]);
    });

    it("writes settings without a new policy version", async () => {
      const { service, mailboxes, audits } = harness();
      const created = await createSupport(service);
      mailboxes.calls.length = 0;
      const renamed = await service.update(actor, workspaceId, created.id, { displayName: "Help desk", threadSendBudget: 5 });
      expect(renamed).toMatchObject({ displayName: "Help desk", threadSendBudget: 5, policyVersion: 1 });
      expect(mailboxes.calls).toEqual(["lockForPolicyChange", "updateSettings"]);
      expect(mailboxes.history).toHaveLength(1);
      expect(audits().at(-1)?.metadata).toEqual(expect.objectContaining({ action: "updated", changedFields: ["displayName", "threadSendBudget"] }));

      const unchanged = await service.update(actor, workspaceId, created.id, { enabled: true, displayName: "Help desk" });
      expect(unchanged.policyVersion).toBe(1);
      expect(mailboxes.calls.filter((call) => call === "updateSettings")).toHaveLength(1);
    });

    it("refuses a stale expectedPolicyVersion with 409 and writes nothing", async () => {
      const { service, mailboxes } = harness();
      const created = await createSupport(service);
      await service.update(actor, workspaceId, created.id, { enabled: false });
      await expectAppError(
        service.update(actor, workspaceId, created.id, { enabled: true, displayName: "Other", expectedPolicyVersion: 1 }),
        409,
        "stale_policy_version",
      );
      expect(mailboxes.records.get(created.id)).toMatchObject({ enabled: false, displayName: "Support", policyVersion: 2 });
      expect(mailboxes.history).toHaveLength(2);
    });

    it("answers 404 for a mailbox outside the workspace", async () => {
      const { service } = harness();
      const created = await createSupport(service);
      await expectAppError(service.update(actor, otherWorkspaceId, created.id, { enabled: false }), 404, "not_found");
      await expectAppError(service.get(otherWorkspaceId, created.id), 404, "not_found");
    });
  });

  describe("relay token rotation", () => {
    it("issues a new relay address and keeps the previous token valid for a seven-day grace", async () => {
      const { service, mailboxes, audits, now } = harness();
      const created = await createSupport(service);
      const previousToken = mailboxes.records.get(created.id)?.relayToken;

      const rotated = await service.rotateRelayToken(actor, workspaceId, created.id);
      expect(rotated.relayAddress).not.toBe(created.relayAddress);
      expect(mailboxes.records.get(created.id)).toMatchObject({
        previousRelayToken: previousToken,
        previousRelayTokenExpiresAt: new Date(now().getTime() + 7 * 24 * HOUR_MS),
      });
      expect(audits().at(-1)).toMatchObject({
        eventType: "email_channel.mailbox",
        metadata: { action: "relay_token_rotated", mailboxId: created.id, graceExpiresAt: new Date(now().getTime() + 7 * 24 * HOUR_MS).toISOString() },
      });
      expect(JSON.stringify(audits())).not.toContain(previousToken);
    });
  });

  describe("setup check", () => {
    it("runs the base step: send to the real address, passed by the next message received", async () => {
      const { service, advance, now } = harness();
      const created = await createSupport(service);
      await service.recordInboundReceipt({ mailboxId: created.id, receivedAt: now(), deliveredTo: [] });

      advance(1000);
      const check = await service.startSetupCheck(workspaceId, created.id, "base");
      expect(check).toEqual({
        step: "base",
        startedAt: now().toISOString(),
        status: "waiting",
        passedAt: null,
        instructions: { sendTo: "support@customer.test" },
      });

      advance(1000);
      const receivedAt = now();
      await service.recordInboundReceipt({ mailboxId: created.id, receivedAt, deliveredTo: [created.relayAddress] });
      const view = await service.get(workspaceId, created.id);
      expect(view.setupCheck).toMatchObject({ step: "base", status: "passed", passedAt: receivedAt.toISOString() });
      expect(view.receiving).toEqual({ state: "ok", lastReceivedAt: receivedAt.toISOString() });
    });

    it("runs the plus_address step and records plus_address_verified_at only for the check's own tagged address", async () => {
      const { service, mailboxes, advance, now } = harness();
      const created = await createSupport(service);
      const check = await service.startSetupCheck(workspaceId, created.id, "plus_address");
      expect(check.instructions.sendTo).toMatch(/^support\+[a-z0-9]+@customer\.test$/);

      advance(1000);
      await service.recordInboundReceipt({ mailboxId: created.id, receivedAt: now(), deliveredTo: ["support@customer.test"] });
      await service.recordInboundReceipt({ mailboxId: created.id, receivedAt: now(), deliveredTo: ["support+other@customer.test"] });
      expect(mailboxes.records.get(created.id)?.plusAddressVerifiedAt).toBeNull();
      expect((await service.get(workspaceId, created.id)).setupCheck?.status).toBe("waiting");

      advance(1000);
      const provenAt = now();
      await service.recordInboundReceipt({
        mailboxId: created.id,
        receivedAt: provenAt,
        deliveredTo: [created.relayAddress, check.instructions.sendTo.toUpperCase()],
      });
      expect(mailboxes.records.get(created.id)?.plusAddressVerifiedAt).toEqual(provenAt);
      const view = await service.get(workspaceId, created.id);
      expect(view.plusAddressVerified).toBe(true);
      expect(view.setupCheck).toMatchObject({ step: "plus_address", status: "passed", passedAt: provenAt.toISOString() });
    });

    it("does not count a tagged message accepted before the check started", async () => {
      const { service, mailboxes, now, advance } = harness();
      const created = await createSupport(service);
      advance(1000);
      const check = await service.startSetupCheck(workspaceId, created.id, "plus_address");
      await service.recordInboundReceipt({
        mailboxId: created.id,
        receivedAt: new Date(now().getTime() - 1),
        deliveredTo: [check.instructions.sendTo],
      });
      expect(mailboxes.records.get(created.id)?.plusAddressVerifiedAt).toBeNull();
    });
  });

  describe("removal", () => {
    it("removes the mailbox and audits it", async () => {
      const { service, audits } = harness();
      const created = await createSupport(service);
      await service.remove(actor, workspaceId, created.id);
      await expectAppError(service.get(workspaceId, created.id), 404, "not_found");
      await expectAppError(service.remove(actor, workspaceId, created.id), 404, "not_found");
      expect(audits().at(-1)?.metadata).toEqual(expect.objectContaining({ action: "removed", mailboxId: created.id }));
      expect(await service.list(workspaceId)).toEqual([]);
    });
  });
});
