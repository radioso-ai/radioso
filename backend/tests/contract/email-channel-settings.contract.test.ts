import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { EngagementMode } from "../../src/modules/emailChannel/public.js";
import { LocalEmailDomainProvisioner } from "../../src/modules/mail/adapters/localDomainProvisioner.js";
import { forbidden } from "../../src/shared/domain/errors.js";
import { createInMemoryEmailChannel, type InMemoryDelivery } from "../support/inMemoryEmailChannel.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const INBOUND_DOMAIN = "in.relay.test";

const RAW_MESSAGE = Buffer.from([
  "From: Alice Example <alice@example.test>",
  "To: QZ2K7XN4VTM3RLHJWPC6YGBSFD@in.relay.test",
  "Cc: support+threadtoken123@customer.test",
  "Subject: Question about my order",
  "Message-ID: <m1@example.test>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Where is my order?",
  "",
].join("\r\n"));

type Harness = Awaited<ReturnType<typeof harness>>;

const harness = async (options: { configured?: boolean; supportedModes?: readonly EngagementMode[] } = {}) => {
  const audit = { record: vi.fn(async () => undefined) };
  const requestDrain = vi.fn(async () => undefined);
  const provisioner = new LocalEmailDomainProvisioner({ spoolDir: await mkdtemp(join(tmpdir(), "email-channel-contract-")) });
  const agents = new Map<string, string>();
  const channel = createInMemoryEmailChannel({
    clock: () => new Date(),
    inboundDomain: INBOUND_DOMAIN,
    provisioner,
    audit,
    drains: { requestDrain },
    agents: { findByIdAndWorkspaceId: async (agentId, workspaceId) => (agents.get(agentId) === workspaceId ? { id: agentId } : null) },
    supportedModes: options.supportedModes,
  });
  const { app, dependencies } = createTestApp({ emailChannel: options.configured === false ? undefined : channel.services });
  const signIn = async () => {
    const session = await issueTestSession(app, `email-channel-${randomUUID()}@example.com`);
    return {
      ...session,
      headers: adminSessionHeaders(session),
      settings: `/api/v1/workspaces/${session.workspaceId}/email-channel`,
    };
  };
  const owner = await signIn();
  return { app, dependencies, channel, audit, requestDrain, provisioner, agents, owner, signIn };
};

const createMailbox = (h: Harness, body: Record<string, unknown> = {}) =>
  request(h.app)
    .post(`${h.owner.settings}/mailboxes`)
    .set(h.owner.headers)
    .send({ address: "support@customer.test", displayName: "Support", ...body });

/**
 * A delivery to `mailboxId` as the inbound processor leaves it, with its raw message stored. A null
 * mailbox is mail the workspace's receiving domain accepted for an address no mailbox has.
 */
const seedDelivery = (h: Harness, mailboxId: string | null, state: "failed" | "done" | "fetched", overrides: Partial<InMemoryDelivery> = {}) => {
  const event = h.channel.inbound.seedEvent({ state: state === "failed" ? "failed" : "processed" });
  const id = randomUUID();
  h.channel.inbound.deliveries.set(id, {
    id,
    inboundEventId: event.id,
    workspaceId: h.owner.workspaceId,
    mailboxId,
    routeRule: "relay",
    acceptedPolicyVersion: 1,
    state,
    classification: "person",
    disposition: state === "done" ? "ingest_only" : null,
    dispositionReason: state === "done" ? "operator_only_mailbox" : null,
    senderAddress: "alice@example.test",
    senderDisplayName: "Alice Example",
    subject: "Question about my order",
    rfcMessageId: "<m1@example.test>",
    referenceIds: [],
    ccAddresses: [],
    receivedFor: [`qz2k7xn4vtm3rlhjwpc6ygbsfd@${INBOUND_DOMAIN}`],
    threadMatch: null,
    threadConflict: false,
    plannedConversationId: null,
    plannedMessageId: null,
    plannedThreadKey: null,
    plannedThreadToken: null,
    conversationId: null,
    messageId: null,
    lastErrorCode: state === "failed" ? "processing_failed" : null,
    createdAt: new Date(),
    processedAt: new Date(),
    bodyText: "Where is my order?",
    rawMime: RAW_MESSAGE,
    rawSizeBytes: RAW_MESSAGE.length,
    rawTruncated: false,
    authResults: { spf: "pass", dkim: "pass", dmarc: "pass" },
    spamVerdict: "not_spam",
    ...overrides,
  });
  return { deliveryId: id, eventId: event.id };
};

/** Denies every permission but the ones named, as a narrower role would. */
const allowOnly = (h: Harness, ...permissions: string[]) =>
  vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
    if (permissions.includes(permission)) return null;
    throw forbidden("You do not have permission to perform this action");
  });

const auditActions = (h: Harness, eventType: string) =>
  (h.audit.record.mock.calls as unknown as [{ eventType: string; metadata: Record<string, unknown> }][])
    .map(([event]) => event)
    .filter((event) => event.eventType === eventType);

describe("email channel settings contract", () => {
  describe("overview", () => {
    it("reports the deployment's modes, inbound domain and the workspace's domains and mailboxes", async () => {
      const h = await harness();
      await createMailbox(h).expect(201);

      const response = await request(h.app).get(h.owner.settings).set(h.owner.headers).expect(200);

      expect(response.body).toMatchObject({
        configured: true,
        inboundDomain: INBOUND_DOMAIN,
        supportedModes: ["operator_only"],
        defaultMode: "operator_only",
        domains: [expect.objectContaining({ domain: "customer.test", sending: expect.objectContaining({ status: "pending" }) })],
        mailboxes: [expect.objectContaining({ address: "support@customer.test" })],
      });
      expect(response.body.domains[0].records.length).toBeGreaterThan(0);
    });

    it("answers configured: false when the deployment has no email provider, and refuses changes", async () => {
      const h = await harness({ configured: false });

      const overview = await request(h.app).get(h.owner.settings).set(h.owner.headers).expect(200);
      expect(overview.body).toEqual({
        configured: false,
        inboundDomain: null,
        supportedModes: [],
        defaultMode: null,
        domains: [],
        mailboxes: [],
      });

      const created = await createMailbox(h).expect(503);
      expect(created.body.error.code).toBe("email_channel_not_configured");
      await request(h.app).get(`/api/v1/conversations/${randomUUID()}/email`).set(h.owner.headers).expect(404);
    });

    it("requires a signed-in teammate", async () => {
      const h = await harness();

      await request(h.app).get(h.owner.settings).expect(401);
      await request(h.app).get(`/api/v1/conversations/${randomUUID()}/email`).expect(401);
    });
  });

  describe("permissions", () => {
    it("reads with workspace.settings.read and changes only with workspace.settings.manage", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      allowOnly(h, "workspace.settings.read");

      await request(h.app).get(h.owner.settings).set(h.owner.headers).expect(200);
      await request(h.app).get(`${h.owner.settings}/mailboxes/${created.body.id}`).set(h.owner.headers).expect(200);
      await request(h.app).get(`${h.owner.settings}/mailboxes/${created.body.id}/events`).set(h.owner.headers).expect(200);
      await request(h.app).get(`${h.owner.settings}/events`).set(h.owner.headers).expect(200);
      await createMailbox(h, { address: "sales@customer.test" }).expect(403);
      await request(h.app).patch(`${h.owner.settings}/mailboxes/${created.body.id}`).set(h.owner.headers).send({ enabled: false }).expect(403);
      await request(h.app).post(`${h.owner.settings}/mailboxes/${created.body.id}/relay-token/rotate`).set(h.owner.headers).expect(403);
      await request(h.app).post(`${h.owner.settings}/domains`).set(h.owner.headers).send({ domain: "example.org" }).expect(403);
      await request(h.app).post(`${h.owner.settings}/domains/${created.body.domainId}/reconcile`).set(h.owner.headers).expect(403);
    });

    it("refuses every route without workspace.settings.read", async () => {
      const h = await harness();
      allowOnly(h, "workspace.conversation.takeover");

      await request(h.app).get(h.owner.settings).set(h.owner.headers).expect(403);
      await request(h.app).get(`${h.owner.settings}/events`).set(h.owner.headers).expect(403);
    });

    it("needs workspace.conversation.takeover as well to read a raw message, and audits nothing it refused", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const { deliveryId } = seedDelivery(h, created.body.id, "done");
      allowOnly(h, "workspace.settings.read", "workspace.settings.manage");

      await request(h.app).get(`${h.owner.settings}/events/${deliveryId}/raw`).set(h.owner.headers).expect(403);
      expect(auditActions(h, "email_channel.raw_message")).toEqual([]);
    });

    it("reads a conversation's email facts with workspace.conversation.takeover", async () => {
      const h = await harness();
      allowOnly(h, "workspace.settings.read");

      await request(h.app).get(`/api/v1/conversations/${randomUUID()}/email`).set(h.owner.headers).expect(403);
    });

    it("shows a relay address only to the mailbox's own workspace", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const stranger = await h.signIn();

      const crossWorkspace = await request(h.app).get(h.owner.settings).set(stranger.headers);
      expect([403, 404]).toContain(crossWorkspace.status);
      expect(JSON.stringify(crossWorkspace.body)).not.toContain(INBOUND_DOMAIN);

      const otherMailbox = await request(h.app).get(`${stranger.settings}/mailboxes/${created.body.id}`).set(stranger.headers).expect(404);
      expect(JSON.stringify(otherMailbox.body)).not.toContain(created.body.relayAddress);
      const strangerOverview = await request(h.app).get(stranger.settings).set(stranger.headers).expect(200);
      expect(JSON.stringify(strangerOverview.body)).not.toContain(created.body.relayAddress);
    });
  });

  describe("mailboxes", () => {
    it("creates a mailbox with a relay address, safe defaults and its domain registered", async () => {
      const h = await harness();
      const agentId = randomUUID();
      h.agents.set(agentId, h.owner.workspaceId);

      const created = await createMailbox(h, { address: "Support@Customer.test", agentId }).expect(201);

      expect(created.body).toMatchObject({
        id: expect.any(String),
        address: "support@customer.test",
        displayName: "Support",
        agentId,
        domainId: expect.any(String),
        relayAddress: expect.stringMatching(/^[a-z0-9]+@/),
        engagementMode: "operator_only",
        enabled: true,
        policyVersion: 1,
        threadSendBudget: 3,
        hourlyGenerationBudget: 30,
        silenceThresholdHours: 72,
        receiving: { state: "waiting_for_first_message", lastReceivedAt: null },
        sending: { state: "not_verified" },
        plusAddressVerified: false,
        setupCheck: null,
      });
      expect(created.body.relayAddress.endsWith(`@${INBOUND_DOMAIN}`)).toBe(true);
      expect(auditActions(h, "email_channel.mailbox").map((event) => event.metadata.action)).toEqual(["created"]);
    });

    it("refuses an invalid address, a duplicate and an unavailable engagement mode", async () => {
      const h = await harness();
      await createMailbox(h).expect(201);

      const invalid = await createMailbox(h, { address: "not an address" }).expect(400);
      expect(invalid.body.error.code).toBe("invalid_address");
      const duplicate = await createMailbox(h).expect(409);
      expect(duplicate.body.error.code).toBe("mailbox_exists");
      const unavailable = await createMailbox(h, { address: "sales@customer.test", engagementMode: "draft" }).expect(409);
      expect(unavailable.body.error).toMatchObject({ code: "engagement_mode_unavailable", details: { supportedModes: ["operator_only"] } });
      await createMailbox(h, { address: "billing@customer.test", threadSendBudget: 0 }).expect(400);
      await createMailbox(h, { address: "billing@customer.test", unknownField: true }).expect(400);
    });

    it("refuses a domain another workspace registered without naming that workspace", async () => {
      const h = await harness();
      await createMailbox(h).expect(201);
      const other = await h.signIn();

      const refused = await request(h.app)
        .post(`${other.settings}/mailboxes`)
        .set(other.headers)
        .send({ address: "help@customer.test", displayName: "Help" })
        .expect(409);

      expect(refused.body.error.code).toBe("domain_claimed_elsewhere");
      expect(JSON.stringify(refused.body)).not.toContain(h.owner.workspaceId);
      expect(JSON.stringify(refused.body)).not.toContain(h.owner.accountId);
    });

    it("reads, updates with optimistic concurrency, rotates and removes a mailbox", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const mailbox = `${h.owner.settings}/mailboxes/${created.body.id}`;

      const read = await request(h.app).get(mailbox).set(h.owner.headers).expect(200);
      expect(read.body).toEqual(created.body);

      const updated = await request(h.app).patch(mailbox).set(h.owner.headers)
        .send({ displayName: "Customer Support", enabled: false, expectedPolicyVersion: 1 })
        .expect(200);
      expect(updated.body).toMatchObject({ displayName: "Customer Support", enabled: false, policyVersion: 2 });

      const stale = await request(h.app).patch(mailbox).set(h.owner.headers).send({ enabled: true, expectedPolicyVersion: 1 }).expect(409);
      expect(stale.body.error).toMatchObject({ code: "stale_policy_version", details: { policyVersion: 2 } });
      const unavailable = await request(h.app).patch(mailbox).set(h.owner.headers).send({ engagementMode: "auto" }).expect(409);
      expect(unavailable.body.error.code).toBe("engagement_mode_unavailable");
      await request(h.app).patch(mailbox).set(h.owner.headers).send({ silenceThresholdHours: 0 }).expect(400);
      await request(h.app).patch(`${h.owner.settings}/mailboxes/${randomUUID()}`).set(h.owner.headers).send({ enabled: true }).expect(404);

      const rotated = await request(h.app).post(`${mailbox}/relay-token/rotate`).set(h.owner.headers).expect(200);
      expect(rotated.body.relayAddress).not.toBe(created.body.relayAddress);
      expect(rotated.body.relayAddress.endsWith(`@${INBOUND_DOMAIN}`)).toBe(true);
      await request(h.app).post(`${h.owner.settings}/mailboxes/${randomUUID()}/relay-token/rotate`).set(h.owner.headers).expect(404);

      await request(h.app).delete(mailbox).set(h.owner.headers).expect(204);
      await request(h.app).get(mailbox).set(h.owner.headers).expect(404);
      await request(h.app).delete(mailbox).set(h.owner.headers).expect(404);
    });

    it("switches a mailbox to auto only with autoOptIn: true", async () => {
      const h = await harness({ supportedModes: ["operator_only", "draft", "auto"] });
      const created = await createMailbox(h).expect(201);
      const mailbox = `${h.owner.settings}/mailboxes/${created.body.id}`;

      const refused = await request(h.app).patch(mailbox).set(h.owner.headers).send({ engagementMode: "auto" }).expect(400);
      expect(refused.body.error.code).toBe("auto_opt_in_required");
      await request(h.app).patch(mailbox).set(h.owner.headers).send({ engagementMode: "auto", autoOptIn: "yes" }).expect(400);

      const switched = await request(h.app).patch(mailbox).set(h.owner.headers)
        .send({ engagementMode: "auto", autoOptIn: true, expectedPolicyVersion: 1 })
        .expect(200);
      expect(switched.body).toMatchObject({ engagementMode: "auto", policyVersion: 2 });
      expect(switched.body).not.toHaveProperty("autoOptIn");

      const createdAuto = await createMailbox(h, { address: "sales@customer.test", engagementMode: "auto" }).expect(400);
      expect(createdAuto.body.error.code).toBe("auto_opt_in_required");
      await createMailbox(h, { address: "sales@customer.test", engagementMode: "auto", autoOptIn: true }).expect(201);
    });

    it("starts a setup check that waits for mail written to the real address", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const mailbox = `${h.owner.settings}/mailboxes/${created.body.id}`;

      const base = await request(h.app).post(`${mailbox}/setup-check`).set(h.owner.headers).send({ step: "base" }).expect(200);
      expect(base.body).toMatchObject({ step: "base", status: "waiting", passedAt: null, instructions: { sendTo: "support@customer.test" } });

      const plus = await request(h.app).post(`${mailbox}/setup-check`).set(h.owner.headers).send({ step: "plus_address" }).expect(200);
      expect(plus.body.instructions.sendTo).toMatch(/^support\+[a-z0-9]+@customer\.test$/);

      await request(h.app).post(`${mailbox}/setup-check`).set(h.owner.headers).send({ step: "other" }).expect(400);
      await request(h.app).post(`${h.owner.settings}/mailboxes/${randomUUID()}/setup-check`).set(h.owner.headers).send({ step: "base" }).expect(404);
    });
  });

  describe("event log", () => {
    it("lists a mailbox's events newest first, and refuses a bad page size or an unknown mailbox", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const { deliveryId } = seedDelivery(h, created.body.id, "failed");
      const events = `${h.owner.settings}/mailboxes/${created.body.id}/events`;

      const listed = await request(h.app).get(events).set(h.owner.headers).expect(200);
      expect(listed.body).toEqual({
        items: [expect.objectContaining({
          id: deliveryId,
          state: "failed",
          classification: "person",
          sender: { address: "alice@example.test", displayName: "Alice Example" },
          subject: "Question about my order",
          auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
          spamVerdict: "not_spam",
          hasRaw: true,
          retryable: true,
        })],
        nextCursor: null,
      });
      const filtered = await request(h.app).get(events).query({ state: "done" }).set(h.owner.headers).expect(200);
      expect(filtered.body.items).toEqual([]);

      await request(h.app).get(events).query({ limit: 101 }).set(h.owner.headers).expect(400);
      const badCursor = await request(h.app).get(events).query({ cursor: "not-a-cursor" }).set(h.owner.headers).expect(400);
      expect(badCursor.body.error.code).toBe("invalid_cursor");
      await request(h.app).get(`${h.owner.settings}/mailboxes/${randomUUID()}/events`).set(h.owner.headers).expect(404);
    });

    it("lists the workspace's log, with mail no mailbox matched and a removed mailbox's retained events, narrowed by mailbox on request", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const { deliveryId: kept } = seedDelivery(h, created.body.id, "done", { createdAt: new Date("2026-10-06T09:00:00.000Z") });
      const { deliveryId: unmatched } = seedDelivery(h, null, "done", {
        routeRule: "direct",
        disposition: "drop",
        dispositionReason: "no_mailbox",
        receivedFor: ["billing@customer.test"],
        createdAt: new Date("2026-10-06T10:00:00.000Z"),
      });
      seedDelivery(h, null, "done", { workspaceId: randomUUID(), dispositionReason: "no_mailbox" });
      await request(h.app).delete(`${h.owner.settings}/mailboxes/${created.body.id}`).set(h.owner.headers).expect(204);
      const events = `${h.owner.settings}/events`;

      const listed = await request(h.app).get(events).set(h.owner.headers).expect(200);
      expect(listed.body).toEqual({
        items: [
          expect.objectContaining({ id: unmatched, mailboxId: null, disposition: "drop", reason: "no_mailbox", hasRaw: true }),
          expect.objectContaining({ id: kept, mailboxId: created.body.id, state: "done" }),
        ],
        nextCursor: null,
      });
      const narrowed = await request(h.app).get(events).query({ mailboxId: created.body.id }).set(h.owner.headers).expect(200);
      expect(narrowed.body.items.map((item: { id: string }) => item.id)).toEqual([kept]);
      const paged = await request(h.app).get(events).query({ limit: 1 }).set(h.owner.headers).expect(200);
      expect(paged.body).toEqual({ items: [expect.objectContaining({ id: unmatched })], nextCursor: unmatched });
      const raw = await request(h.app).get(`${h.owner.settings}/events/${unmatched}/raw`).set(h.owner.headers).expect(200);
      expect(raw.body).toMatchObject({ text: expect.stringContaining("Where is my order?") });

      await request(h.app).get(`${h.owner.settings}/mailboxes/${created.body.id}/events`).set(h.owner.headers).expect(404);
      await request(h.app).get(events).query({ mailboxId: "not-a-uuid" }).set(h.owner.headers).expect(400);
      const badCursor = await request(h.app).get(events).query({ cursor: "not-a-cursor" }).set(h.owner.headers).expect(400);
      expect(badCursor.body.error.code).toBe("invalid_cursor");
    });

    it("retries a failed event from where it stopped, audits it and pushes a drain", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const { deliveryId, eventId } = seedDelivery(h, created.body.id, "failed");

      const retried = await request(h.app).post(`${h.owner.settings}/events/${deliveryId}/retry`).set(h.owner.headers).expect(202);

      expect(retried.body).toMatchObject({ id: deliveryId, state: "fetched", retryable: false });
      expect(h.channel.inbound.events.get(eventId)?.state).toBe("pending");
      expect(auditActions(h, "email_channel.event")).toEqual([
        expect.objectContaining({ workspaceId: h.owner.workspaceId, metadata: expect.objectContaining({ action: "retried", deliveryId }) }),
      ]);
      expect(h.requestDrain).toHaveBeenCalledWith(expect.objectContaining({ stage: "inbound" }));

      const again = await request(h.app).post(`${h.owner.settings}/events/${deliveryId}/retry`).set(h.owner.headers).expect(409);
      expect(again.body.error.code).toBe("event_not_failed");
      await request(h.app).post(`${h.owner.settings}/events/${randomUUID()}/retry`).set(h.owner.headers).expect(404);
    });

    it("shows the sanitized raw message without relay or thread tokens, and audits the view", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const { deliveryId } = seedDelivery(h, created.body.id, "done");

      const raw = await request(h.app).get(`${h.owner.settings}/events/${deliveryId}/raw`).set(h.owner.headers).expect(200);

      expect(raw.body).toMatchObject({ text: expect.stringContaining("Where is my order?"), sanitizedHtml: null, truncated: false, attachments: [] });
      const headerNames = (raw.body.headers as { name: string }[]).map((header) => header.name.toLowerCase());
      expect(headerNames).toEqual(expect.arrayContaining(["from", "subject"]));
      expect(headerNames).not.toContain("to");
      expect(headerNames).not.toContain("cc");
      expect(JSON.stringify(raw.body).toLowerCase()).not.toContain("qz2k7xn4vtm3rlhjwpc6ygbsfd");
      expect(JSON.stringify(raw.body)).not.toContain("threadtoken123");
      expect(auditActions(h, "email_channel.raw_message")).toEqual([
        expect.objectContaining({ metadata: expect.objectContaining({ action: "viewed", deliveryId, conversationId: null }) }),
      ]);
    });

    it("answers 410 once the raw message is purged and 404 for an event of another workspace", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const { deliveryId } = seedDelivery(h, created.body.id, "done", { rawMime: null });
      const stranger = await h.signIn();

      const purged = await request(h.app).get(`${h.owner.settings}/events/${deliveryId}/raw`).set(h.owner.headers).expect(410);
      expect(purged.body.error.code).toBe("raw_purged");
      await request(h.app).get(`${stranger.settings}/events/${deliveryId}/raw`).set(stranger.headers).expect(404);
      await request(h.app).post(`${stranger.settings}/events/${deliveryId}/retry`).set(stranger.headers).expect(404);
    });
  });

  describe("sending domains", () => {
    it("adds, verifies, enables direct receiving on and removes a domain", async () => {
      const h = await harness();
      const added = await request(h.app).post(`${h.owner.settings}/domains`).set(h.owner.headers).send({ domain: "Example.org" }).expect(201);
      expect(added.body).toMatchObject({
        id: expect.any(String),
        domain: "example.org",
        sending: { status: "pending" },
        receiving: { status: "not_requested" },
      });
      const domain = `${h.owner.settings}/domains/${added.body.id}`;

      const verified = await request(h.app).post(`${domain}/verify`).set(h.owner.headers).expect(200);
      expect(verified.body.id).toBe(added.body.id);

      const mismatch = await request(h.app).post(`${domain}/receiving`).set(h.owner.headers).send({ confirmation: "example.com" }).expect(400);
      expect(mismatch.body.error.code).toBe("confirmation_mismatch");
      const receiving = await request(h.app).post(`${domain}/receiving`).set(h.owner.headers).send({ confirmation: "example.org" }).expect(200);
      expect(receiving.body.receiving.status).toBe("pending");

      await request(h.app).delete(domain).set(h.owner.headers).expect(204);
      await request(h.app).post(`${domain}/verify`).set(h.owner.headers).expect(404);
      await request(h.app).delete(domain).set(h.owner.headers).expect(404);
    });

    it("refuses an invalid domain, one claimed elsewhere, a domain with mailboxes and an unreachable provider", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const other = await h.signIn();

      const invalid = await request(h.app).post(`${h.owner.settings}/domains`).set(h.owner.headers).send({ domain: "not a domain" }).expect(400);
      expect(invalid.body.error.code).toBe("invalid_domain");
      const claimed = await request(h.app).post(`${other.settings}/domains`).set(other.headers).send({ domain: "customer.test" }).expect(409);
      expect(claimed.body.error.code).toBe("domain_claimed_elsewhere");
      expect(JSON.stringify(claimed.body)).not.toContain(h.owner.workspaceId);

      const domain = `${h.owner.settings}/domains/${created.body.domainId}`;
      const inUse = await request(h.app).delete(domain).set(h.owner.headers).expect(409);
      expect(inUse.body.error.code).toBe("domain_has_mailboxes");

      vi.spyOn(h.provisioner, "requestVerification").mockRejectedValue(new Error("provider down"));
      const unavailable = await request(h.app).post(`${domain}/verify`).set(h.owner.headers).expect(502);
      expect(unavailable.body.error.code).toBe("provider_unavailable");
    });

    it("adopts a domain the provider already holds only when an operator reconciles it, and audits the adoption", async () => {
      const h = await harness();
      // Registered on the provider account outside this workspace's claim.
      const existing = await h.provisioner.registerSendingDomain("example.org");
      if (!existing.ok) throw new Error("expected a provider registration");
      vi.spyOn(h.provisioner, "registerSendingDomain").mockResolvedValueOnce({ ok: false, refused: "already_registered" });

      const added = await request(h.app).post(`${h.owner.settings}/domains`).set(h.owner.headers).send({ domain: "example.org" }).expect(201);
      expect(added.body).toMatchObject({ domain: "example.org", registration: { status: "needs_reconciliation" }, records: [] });
      const overview = await request(h.app).get(h.owner.settings).set(h.owner.headers).expect(200);
      expect(overview.body.domains).toEqual([expect.objectContaining({ id: added.body.id, registration: { status: "needs_reconciliation" } })]);

      const domain = `${h.owner.settings}/domains/${added.body.id}`;
      const blockedMailbox = await createMailbox(h, { address: "support@example.org" }).expect(409);
      expect(blockedMailbox.body.error.code).toBe("domain_needs_reconciliation");
      const blockedCheck = await request(h.app).post(`${domain}/verify`).set(h.owner.headers).expect(409);
      expect(blockedCheck.body.error.code).toBe("domain_needs_reconciliation");

      const reconciled = await request(h.app).post(`${domain}/reconcile`).set(h.owner.headers).expect(200);
      expect(reconciled.body).toMatchObject({ id: added.body.id, registration: { status: "registered" } });
      expect(reconciled.body.records.length).toBeGreaterThan(0);
      expect(auditActions(h, "email_channel.domain").map((event) => event.metadata)).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "reconciliation_required", domainId: added.body.id }),
        expect.objectContaining({ action: "reconciled", domainId: added.body.id, outcome: "adopted" }),
      ]));
      await request(h.app).post(`${domain}/reconcile`).set(h.owner.headers).expect(200);
      await createMailbox(h, { address: "support@example.org" }).expect(201);

      const other = await h.signIn();
      await request(h.app).post(`${other.settings}/domains/${added.body.id}/reconcile`).set(other.headers).expect(404);
    });

    it("refuses to reconcile a domain the provider has not reported, and to add a domain whose removal is still being cleaned up", async () => {
      const h = await harness();
      vi.spyOn(h.provisioner, "registerSendingDomain").mockRejectedValueOnce(new Error("socket hang up"));
      await request(h.app).post(`${h.owner.settings}/domains`).set(h.owner.headers).send({ domain: "example.org" }).expect(502);
      const [claim] = (await request(h.app).get(h.owner.settings).set(h.owner.headers).expect(200)).body.domains;
      expect(claim).toMatchObject({ registration: { status: "registering" } });
      const notAwaiting = await request(h.app).post(`${h.owner.settings}/domains/${claim.id}/reconcile`).set(h.owner.headers).expect(409);
      expect(notAwaiting.body.error.code).toBe("domain_not_awaiting_reconciliation");

      await request(h.app).delete(`${h.owner.settings}/domains/${claim.id}`).set(h.owner.headers).expect(204);
      const pending = await request(h.app).post(`${h.owner.settings}/domains`).set(h.owner.headers).send({ domain: "example.org" }).expect(409);
      expect(pending.body.error.code).toBe("domain_removal_pending");
    });
  });

  describe("conversation email facts", () => {
    it("reads an email conversation's facts for the inbox, and 404s for any other conversation", async () => {
      const h = await harness();
      const created = await createMailbox(h).expect(201);
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const { deliveryId } = seedDelivery(h, created.body.id, "done");
      await h.channel.threads.upsertLink({
        conversationId,
        workspaceId: h.owner.workspaceId,
        mailboxId: created.body.id,
        threadKey: randomUUID(),
        threadToken: "threadtoken123",
        participantAddress: "alice@example.test",
      });
      await h.channel.threads.recordLatestInbound(conversationId, {
        subject: "Question about my order",
        participantDisplayName: "Alice Example",
        ccAddresses: ["bob@example.test"],
        inboundAt: new Date("2026-10-03T09:00:00.000Z"),
      });
      await h.channel.threads.insertIndexEntries([{
        workspaceId: h.owner.workspaceId,
        mailboxId: created.body.id,
        conversationId,
        messageId,
        direction: "inbound",
        origin: "inbound",
        rfcMessageId: "<m1@example.test>",
        subject: "Question about my order",
        ccAddresses: ["bob@example.test"],
        attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 1024 }],
        inboundDeliveryId: deliveryId,
      }]);

      const facts = await request(h.app).get(`/api/v1/conversations/${conversationId}/email`).set(h.owner.headers).expect(200);

      expect(facts.body).toEqual({
        mailbox: { id: created.body.id, address: "support@customer.test", displayName: "Support", engagementMode: "operator_only" },
        participant: { address: "alice@example.test", displayName: "Alice Example" },
        latest: { subject: "Question about my order", cc: ["bob@example.test"], inboundAt: "2026-10-03T09:00:00.000Z" },
        sending: { state: "not_verified" },
        sendBudget: { used: 0, limit: 3, renewedAt: null },
        messages: [{
          messageId,
          direction: "inbound",
          subject: "Question about my order",
          cc: ["bob@example.test"],
          attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 1024 }],
          delivery: null,
          rawDeliveryId: deliveryId,
        }],
      });
      expect(JSON.stringify(facts.body)).not.toContain("threadtoken123");

      const stranger = await h.signIn();
      await request(h.app).get(`/api/v1/conversations/${conversationId}/email`).set(stranger.headers).expect(404);
      await request(h.app).get(`/api/v1/conversations/${randomUUID()}/email`).set(h.owner.headers).expect(404);
      await request(h.app).get("/api/v1/conversations/not-a-uuid/email").set(h.owner.headers).expect(400);
    });
  });
});
