import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createPostgresMailboxPolicyChangeUnitOfWork } from "../../src/app/composition/mailboxPolicyChange.js";
import {
  EmailDomainRepository,
  EmailInboundRepository,
  EmailMailboxRepository,
  EmailThreadRepository,
  lockThreadResolution,
} from "../../src/modules/emailChannel/public.js";
import { threadResolutionLockKey } from "../../src/modules/emailChannel/persistence/threadResolutionLock.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const HOUR_MS = 60 * 60 * 1000;
const token = () => randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase();

describeIntegration("email channel persistence (Postgres)", () => {
  const testDatabaseName = `email_channel_persistence_${randomUUID().replaceAll("-", "")}_test`;
  let testDatabaseUrl = "";
  let database: Database;
  let domains: EmailDomainRepository;
  let mailboxes: EmailMailboxRepository;
  let inbound: EmailInboundRepository;
  let threads: EmailThreadRepository;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`CREATE DATABASE "${testDatabaseName}" TEMPLATE template0`);
    } finally {
      await admin.end();
    }
    const url = new URL(integrationDatabaseUrl);
    url.pathname = `/${testDatabaseName}`;
    url.searchParams.delete("options");
    testDatabaseUrl = url.toString();
    database = new Database(testDatabaseUrl);
    await runAllTestMigrations(database);
    domains = new EmailDomainRepository(database.kysely);
    mailboxes = new EmailMailboxRepository(database.kysely);
    inbound = new EmailInboundRepository(database.kysely);
    threads = new EmailThreadRepository(database.kysely);
  }, 60_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${testDatabaseName}" WITH (FORCE)`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  const seedWorkspace = async () => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    await database.execute("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Acct', $2, 'hash')", [
      accountId,
      `email-persistence-${accountId}@example.test`,
    ]);
    await database.execute("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'WS', $3)", [
      workspaceId,
      accountId,
      `rk-${workspaceId}`,
    ]);
    await database.execute("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Agent')", [agentId, workspaceId]);
    return { workspaceId, agentId };
  };

  const uniqueDomain = () => `d${randomUUID().slice(0, 8)}.example.test`;

  const createDomain = async (workspaceId: string, domain = uniqueDomain()) => {
    const record = await domains.insertActive({
      workspaceId,
      domain,
      provider: "local",
      providerDomainId: `local-${randomUUID()}`,
      providerRegion: null,
      dnsRecords: [{ purpose: "dkim", type: "TXT", name: `resend._domainkey.${domain}`, value: "p=abc", status: "pending" }],
      sendingStatus: "pending",
      receivingStatus: "not_requested",
      nextCheckAt: new Date(Date.now() + HOUR_MS),
      createdByUserId: null,
    });
    if (!record) throw new Error("domain fixture conflicted");
    return record;
  };

  const createMailbox = async (
    workspaceId: string,
    domain: { id: string; domain: string },
    overrides: { local?: string; agentId?: string | null; relayToken?: string } = {},
  ) => {
    const record = await mailboxes.createWithPolicy({
      workspaceId,
      domainId: domain.id,
      agentId: overrides.agentId ?? null,
      address: `${overrides.local ?? "support"}@${domain.domain}`,
      displayName: "Support",
      relayToken: overrides.relayToken ?? token(),
      engagementMode: "operator_only",
      enabled: true,
      threadSendBudget: 3,
      hourlyGenerationBudget: 30,
      threadContextMessages: 10,
      spamOptIn: false,
      silenceThresholdHours: 72,
      createdByUserId: null,
    });
    if (!record) throw new Error("mailbox fixture conflicted");
    return record;
  };

  const seedMailbox = async () => {
    const { workspaceId, agentId } = await seedWorkspace();
    const domain = await createDomain(workspaceId);
    const mailbox = await createMailbox(workspaceId, domain);
    return { workspaceId, agentId, domain, mailbox };
  };

  const insertConversation = async (workspaceId: string) => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await database.execute("INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'email')", [
      conversationId,
      workspaceId,
    ]);
    await database.execute(
      "INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', 'Hello')",
      [messageId, conversationId, workspaceId],
    );
    return { conversationId, messageId };
  };

  const insertEvent = async (overrides: { providerEventId?: string; providerObjectId?: string | null } = {}) => {
    const result = await inbound.insertEvent({
      provider: "local",
      providerEventId: overrides.providerEventId ?? `evt_${randomUUID()}`,
      eventKind: "message_received",
      providerObjectId: overrides.providerObjectId === undefined ? `obj_${randomUUID()}` : overrides.providerObjectId,
      envelope: { subject: "Hello" },
    });
    return result.eventId;
  };

  const fetchedContent = (input: { rfcMessageId: string; referenceIds?: string[]; raw?: boolean }) => ({
    classification: "person" as const,
    senderAddress: "person@example.org",
    senderDisplayName: "Person",
    subject: "Question",
    rfcMessageId: input.rfcMessageId,
    referenceIds: input.referenceIds ?? [],
    ccAddresses: [],
    receivedFor: [],
    authResults: { spf: "pass", dkim: "pass", dmarc: "pass" },
    spamVerdict: "unknown" as const,
    attachments: [],
    bodyText: "Hello",
    stripConfidence: "confident" as const,
    rawMime: input.raw ? Buffer.from("raw message") : null,
    rawSizeBytes: input.raw ? 11 : null,
    rawTruncated: false,
  });

  /** A delivery of `mailbox` carrying `rfcMessageId`, reserved to `conversationId`. */
  const reservedDelivery = async (
    mailbox: { id: string; workspaceId: string },
    input: { rfcMessageId: string; referenceIds?: string[]; conversationId: string },
  ) => {
    const eventId = await insertEvent();
    const { deliveryId } = await inbound.insertDelivery({
      inboundEventId: eventId,
      workspaceId: mailbox.workspaceId,
      mailboxId: mailbox.id,
      routeRule: "relay",
      acceptedPolicyVersion: 1,
    });
    expect(await inbound.recordFetched(deliveryId, fetchedContent(input))).toBe(true);
    expect(await inbound.reserveThread(deliveryId, {
      threadMatch: "new_thread",
      threadConflict: false,
      disposition: "ingest_only",
      dispositionReason: "operator_only_mailbox",
      plannedConversationId: input.conversationId,
      plannedMessageId: randomUUID(),
      plannedThreadKey: randomUUID(),
      plannedThreadToken: token(),
    })).toBe(true);
    return deliveryId;
  };

  it("keeps an active sending domain unique across workspaces until it is removed", async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const domain = uniqueDomain();
    const claimed = await createDomain(first.workspaceId, domain);

    expect(await domains.insertActive({
      workspaceId: second.workspaceId,
      domain,
      provider: "local",
      providerDomainId: "other",
      providerRegion: null,
      dnsRecords: [],
      sendingStatus: "pending",
      receivingStatus: "not_requested",
      nextCheckAt: new Date(),
      createdByUserId: null,
    })).toBeNull();
    expect((await domains.findActiveByDomain(domain))?.workspaceId).toBe(first.workspaceId);
    expect((await domains.findActive(first.workspaceId, claimed.id))?.dnsRecords).toEqual(claimed.dnsRecords);
    expect(await domains.findActive(second.workspaceId, claimed.id)).toBeNull();
    expect(await domains.findReceivingVerified(domain)).toBeNull();

    expect(await domains.markRemoved(first.workspaceId, claimed.id)).toMatchObject({ providerCleanupStatus: "pending" });
    expect(await domains.findActiveByDomain(domain)).toBeNull();
    expect((await domains.findById(claimed.id))?.removedAt).toBeInstanceOf(Date);
    const reclaimed = await createDomain(second.workspaceId, domain);
    expect(reclaimed.workspaceId).toBe(second.workspaceId);
    expect((await domains.listActive(first.workspaceId)).map((record) => record.id)).not.toContain(claimed.id);
  });

  it("refreshes readiness when due, confirms receiving, and leaves removed domains for asynchronous cleanup", async () => {
    const { workspaceId } = await seedWorkspace();
    const domain = await createDomain(workspaceId);
    await database.execute("UPDATE email_domains SET next_check_at = now() - interval '1 minute' WHERE id = $1", [domain.id]);
    expect((await domains.listDueForRefresh(100)).map((record) => record.id)).toContain(domain.id);
    await domains.deferRefresh(domain.id, new Date(Date.now() + HOUR_MS));
    expect((await domains.listDueForRefresh(100)).map((record) => record.id)).not.toContain(domain.id);
    expect((await domains.findById(domain.id))?.lastCheckedAt?.getTime()).toBe(domain.lastCheckedAt?.getTime());
    await database.execute("UPDATE email_domains SET next_check_at = now() - interval '1 minute' WHERE id = $1", [domain.id]);

    const verified = await domains.recordReadiness(domain.id, {
      sendingStatus: "verified",
      receivingStatus: "not_requested",
      dnsRecords: [{ purpose: "dkim", type: "TXT", name: "k", value: "v", status: "verified" }],
      nextCheckAt: new Date(Date.now() + 24 * HOUR_MS),
      statusChanged: true,
    });
    expect(verified).toMatchObject({ sendingStatus: "verified", dnsRecords: [{ status: "verified" }] });
    expect((await domains.listDueForRefresh(100)).map((record) => record.id)).not.toContain(domain.id);

    const confirmed = await domains.confirmReceiving(domain.id, {
      confirmedByUserId: null,
      readiness: { sendingStatus: "verified", receivingStatus: "verified", dnsRecords: [], nextCheckAt: new Date(), statusChanged: true },
    });
    expect(confirmed?.receivingConfirmedAt).toBeInstanceOf(Date);
    expect(await domains.findReceivingVerified(domain.domain)).toEqual({ workspaceId });

    await domains.markRemoved(workspaceId, domain.id);
    expect(await domains.findReceivingVerified(domain.domain)).toBeNull();
    expect((await domains.listCleanupDue(100)).map((record) => record.id)).toContain(domain.id);
    await domains.recordCleanup(domain.id, { status: "failed", retryAt: new Date(Date.now() + HOUR_MS) });
    expect((await domains.listCleanupDue(100)).map((record) => record.id)).not.toContain(domain.id);
    await domains.recordCleanup(domain.id, { status: "done", retryAt: null });
    expect((await domains.findById(domain.id))?.providerCleanupStatus).toBe("done");
    expect((await domains.listCleanupDue(100)).map((record) => record.id)).not.toContain(domain.id);
  });

  it("keeps an active mailbox address unique across workspaces and writes policy version 1 with the mailbox", async () => {
    const { workspaceId, agentId, domain, mailbox } = await seedMailbox();
    expect(mailbox).toMatchObject({ policyVersion: 1, engagementMode: "operator_only", enabled: true });
    expect(await mailboxes.listPolicyHistory(mailbox.id)).toEqual([
      expect.objectContaining({ version: 1, engagementMode: "operator_only", enabled: true, agentId: null }),
    ]);

    await expect(createMailbox(workspaceId, domain)).rejects.toThrow("mailbox fixture conflicted");
    const other = await seedWorkspace();
    await expect(createMailbox(other.workspaceId, domain)).rejects.toThrow("mailbox fixture conflicted");
    expect(await mailboxes.listPolicyHistory(mailbox.id)).toHaveLength(1);

    const sales = await createMailbox(workspaceId, domain, { local: "sales", agentId });
    expect(await mailboxes.countActiveOnDomain(domain.id)).toBe(2);
    expect((await mailboxes.listActive(workspaceId)).map((record) => record.id)).toEqual([mailbox.id, sales.id]);

    expect(await mailboxes.markRemoved(workspaceId, mailbox.id)).not.toBeNull();
    expect(await mailboxes.findActive(workspaceId, mailbox.id)).toBeNull();
    expect((await mailboxes.findById(mailbox.id))?.removedAt).toBeInstanceOf(Date);
    const recreated = await createMailbox(workspaceId, domain);
    expect(recreated.address).toBe(mailbox.address);
    expect(await mailboxes.countActiveOnDomain(domain.id)).toBe(2);
  });

  it("resolves the relay token, and the previous one only within its rotation grace", async () => {
    const { workspaceId, mailbox } = await seedMailbox();
    expect(await mailboxes.resolveRelayToken(mailbox.relayToken)).toEqual({
      mailboxId: mailbox.id,
      workspaceId,
      generation: "current",
    });
    expect(await mailboxes.findActiveByAddress(mailbox.address)).toEqual({ mailboxId: mailbox.id, workspaceId });

    const rotatedTo = token();
    const rotated = await mailboxes.rotateRelayToken(workspaceId, mailbox.id, { relayToken: rotatedTo, graceSeconds: 7 * 24 * 3600 });
    expect(rotated).toMatchObject({ relayToken: rotatedTo, previousRelayToken: mailbox.relayToken });
    expect(rotated?.previousRelayTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * HOUR_MS);
    expect((await mailboxes.resolveRelayToken(rotatedTo))?.generation).toBe("current");
    expect((await mailboxes.resolveRelayToken(mailbox.relayToken))?.generation).toBe("previous");

    await database.execute(
      "UPDATE email_mailboxes SET previous_relay_token_expires_at = now() - interval '1 second' WHERE id = $1",
      [mailbox.id],
    );
    expect(await mailboxes.resolveRelayToken(mailbox.relayToken)).toBeNull();
    expect(await mailboxes.resolveRelayToken(token())).toBeNull();

    await mailboxes.markRemoved(workspaceId, mailbox.id);
    expect(await mailboxes.resolveRelayToken(rotatedTo)).toBeNull();
    expect(await mailboxes.findActiveByAddress(mailbox.address)).toBeNull();
  });

  it("records settings, setup checks and receipts without moving the last received time backwards", async () => {
    const { workspaceId, mailbox } = await seedMailbox();
    expect(await mailboxes.updateSettings(workspaceId, mailbox.id, { displayName: "Help desk", threadSendBudget: 5 }))
      .toMatchObject({ displayName: "Help desk", threadSendBudget: 5, policyVersion: 1 });

    const checking = await mailboxes.startSetupCheck(workspaceId, mailbox.id, "plus_address");
    expect(checking).toMatchObject({ setupCheckStep: "plus_address" });
    expect(checking?.setupCheckStartedAt).toBeInstanceOf(Date);

    const later = new Date(Date.now() + 1000);
    const earlier = new Date(Date.now() - HOUR_MS);
    await mailboxes.recordReceipt(mailbox.id, { receivedAt: later, plusAddressProven: false });
    await mailboxes.recordReceipt(mailbox.id, { receivedAt: earlier, plusAddressProven: true });
    const received = await mailboxes.findActiveById(mailbox.id);
    expect(received?.lastReceivedAt?.getTime()).toBe(later.getTime());
    expect(received?.plusAddressVerifiedAt?.getTime()).toBe(earlier.getTime());
  });

  it("appends policy versions through the policy-change unit of work and finds the version effective at a time", async () => {
    const { workspaceId, agentId, mailbox } = await seedMailbox();
    const changes = createPostgresMailboxPolicyChangeUnitOfWork({ db: database.kysely });

    const changed = await changes.run(async (scope) => {
      const locked = await scope.mailboxes.lockForPolicyChange(workspaceId, mailbox.id);
      if (!locked) throw new Error("mailbox not found");
      return scope.mailboxes.appendPolicyVersion({
        mailboxId: mailbox.id,
        expectedVersion: locked.policyVersion,
        engagementMode: "operator_only",
        enabled: false,
        agentId,
        changedByUserId: null,
      });
    });
    expect(changed).toMatchObject({ policyVersion: 2, enabled: false, agentId });

    const stale = await changes.run((scope) =>
      scope.mailboxes.appendPolicyVersion({
        mailboxId: mailbox.id,
        expectedVersion: 1,
        engagementMode: "operator_only",
        enabled: true,
        agentId: null,
        changedByUserId: null,
      }));
    expect(stale).toBeNull();
    expect((await mailboxes.listPolicyHistory(mailbox.id)).map((policy) => [policy.version, policy.enabled])).toEqual([
      [1, true],
      [2, false],
    ]);

    await expect(changes.run(async (scope) => {
      await scope.mailboxes.appendPolicyVersion({
        mailboxId: mailbox.id,
        expectedVersion: 2,
        engagementMode: "operator_only",
        enabled: true,
        agentId: null,
        changedByUserId: null,
      });
      throw new Error("abort after the write");
    })).rejects.toThrow("abort after the write");
    expect((await mailboxes.findActiveById(mailbox.id))?.policyVersion).toBe(2);
    expect(await mailboxes.listPolicyHistory(mailbox.id)).toHaveLength(2);

    await database.execute(
      `UPDATE email_mailbox_policies
          SET effective_at = CASE version WHEN 1 THEN now() - interval '2 hours' ELSE now() - interval '1 hour' END
        WHERE mailbox_id = $1`,
      [mailbox.id],
    );
    const now = Date.now();
    expect(await mailboxes.policyEffectiveAt(mailbox.id, new Date(now - 3 * HOUR_MS))).toBeNull();
    expect((await mailboxes.policyEffectiveAt(mailbox.id, new Date(now - 90 * 60 * 1000)))?.version).toBe(1);
    expect(await mailboxes.policyEffectiveAt(mailbox.id, new Date(now - 30 * 60 * 1000))).toMatchObject({
      version: 2,
      enabled: false,
      agentId,
    });
  });

  it("deduplicates provider events on the event id and on the received message id", async () => {
    const objectId = `obj_${randomUUID()}`;
    const first = await inbound.insertEvent({
      provider: "local",
      providerEventId: "evt_dedupe_1",
      eventKind: "message_received",
      providerObjectId: objectId,
      envelope: {},
    });
    expect(first.duplicate).toBe(false);
    expect(await inbound.insertEvent({
      provider: "local",
      providerEventId: "evt_dedupe_1",
      eventKind: "message_received",
      providerObjectId: objectId,
      envelope: {},
    })).toEqual({ eventId: first.eventId, duplicate: true });
    expect(await inbound.insertEvent({
      provider: "local",
      providerEventId: "evt_dedupe_2",
      eventKind: "message_received",
      providerObjectId: objectId,
      envelope: {},
    })).toEqual({ eventId: first.eventId, duplicate: true });

    const statusEvent = await inbound.insertEvent({
      provider: "local",
      providerEventId: "evt_dedupe_3",
      eventKind: "delivery_status",
      providerObjectId: objectId,
      envelope: {},
    });
    expect(statusEvent.duplicate).toBe(false);
    const otherProvider = await inbound.insertEvent({
      provider: "resend",
      providerEventId: "evt_dedupe_1",
      eventKind: "message_received",
      providerObjectId: objectId,
      envelope: {},
    });
    expect(otherProvider.duplicate).toBe(false);
  });

  it("keeps one delivery per event and mailbox, and one unrouted delivery per event", async () => {
    const { workspaceId, domain, mailbox } = await seedMailbox();
    const second = await createMailbox(workspaceId, domain, { local: "sales" });
    const eventId = await insertEvent();
    const routed = { inboundEventId: eventId, workspaceId, routeRule: "relay" as const, acceptedPolicyVersion: 1 };

    const first = await inbound.insertDelivery({ ...routed, mailboxId: mailbox.id });
    expect(first.duplicate).toBe(false);
    expect(await inbound.insertDelivery({ ...routed, mailboxId: mailbox.id })).toEqual({ deliveryId: first.deliveryId, duplicate: true });
    expect((await inbound.insertDelivery({ ...routed, mailboxId: second.id })).duplicate).toBe(false);

    const unrouted = {
      inboundEventId: eventId,
      workspaceId: null,
      mailboxId: null,
      routeRule: null,
      acceptedPolicyVersion: null,
      settled: { disposition: "drop" as const, dispositionReason: "no_mailbox" as const },
    };
    const dropped = await inbound.insertDelivery(unrouted);
    expect(dropped.duplicate).toBe(false);
    expect(await inbound.insertDelivery(unrouted)).toEqual({ deliveryId: dropped.deliveryId, duplicate: true });

    const deliveries = await inbound.listEventDeliveries(eventId);
    expect(deliveries).toHaveLength(3);
    expect(deliveries.find((delivery) => delivery.id === dropped.deliveryId)).toMatchObject({
      state: "done",
      disposition: "drop",
      dispositionReason: "no_mailbox",
      workspaceId: null,
    });
  });

  it("claims due events with SKIP LOCKED, fences writes on the claim, and reclaims an expired lease", async () => {
    await database.execute("UPDATE email_inbound_events SET state = 'processed' WHERE state IN ('pending', 'processing')");
    const ids = [await insertEvent(), await insertEvent(), await insertEvent()];

    let releaseFirst: () => void = () => undefined;
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstClaimed: string[] = [];
    let signalClaimed: () => void = () => undefined;
    const claimedInFirst = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });
    const firstTransaction = database.kysely.transaction().execute(async (trx) => {
      firstClaimed = (await new EmailInboundRepository(trx).claimDueEvents({ limit: 2, leaseSeconds: 60 })).map((event) => event.id);
      signalClaimed();
      await firstHolds;
    });
    await claimedInFirst;
    const secondClaimed = await inbound.claimDueEvents({ limit: 5, leaseSeconds: 60 });
    releaseFirst();
    await firstTransaction;

    expect(firstClaimed).toHaveLength(2);
    expect(secondClaimed.map((event) => event.id)).toEqual(ids.filter((id) => !firstClaimed.includes(id)));
    expect(secondClaimed[0]).toMatchObject({ state: "processing", attempts: 1 });
    expect(await inbound.claimDueEvents({ limit: 5, leaseSeconds: 60 })).toEqual([]);

    const [expiredId, retriedId, settledId] = ids as [string, string, string];
    await database.execute("UPDATE email_inbound_events SET lease_until = now() - interval '1 second' WHERE id = $1", [expiredId]);
    const reclaimed = await inbound.claimDueEvents({ limit: 5, leaseSeconds: 60 });
    expect(reclaimed.map((event) => [event.id, event.attempts])).toEqual([[expiredId, 2]]);
    expect(await inbound.settleEvent(expiredId, { attempt: 1, state: "processed", errorCode: null })).toBe(false);
    expect(await inbound.settleEvent(expiredId, { attempt: 2, state: "processed", errorCode: null })).toBe(true);

    expect(await inbound.retryEventLater(retriedId, { attempt: 1, nextAttemptAt: new Date(Date.now() + HOUR_MS), errorCode: "fetch_timeout" }))
      .toBe(true);
    expect(await inbound.claimDueEvents({ limit: 5, leaseSeconds: 60 })).toEqual([]);
    await database.execute("UPDATE email_inbound_events SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [retriedId]);
    expect((await inbound.claimDueEvents({ limit: 5, leaseSeconds: 60 })).map((event) => [event.id, event.attempts, event.lastErrorCode]))
      .toEqual([[retriedId, 2, "fetch_timeout"]]);

    expect(await inbound.settleEvent(settledId, { attempt: 1, state: "failed", errorCode: "fetch_failed" })).toBe(true);
    expect(await inbound.settleEvent(settledId, { attempt: 1, state: "processed", errorCode: null })).toBe(false);
  });

  it("finds forward reservations and reverse references within the destination mailbox only", async () => {
    const { workspaceId, domain, mailbox } = await seedMailbox();
    const otherMailbox = await createMailbox(workspaceId, domain, { local: "sales" });
    const parent = await insertConversation(workspaceId);
    const elsewhere = await insertConversation(workspaceId);
    const parentId = `<parent.${randomUUID()}@example.org>`;
    const childId = `<child.${randomUUID()}@example.org>`;
    const rootId = `<root.${randomUUID()}@example.org>`;
    const unreservedId = `<pending.${randomUUID()}@example.org>`;

    const parentDelivery = await reservedDelivery(mailbox, { rfcMessageId: parentId, conversationId: parent.conversationId });
    await reservedDelivery(otherMailbox, { rfcMessageId: parentId, conversationId: elsewhere.conversationId });
    const pendingEvent = await insertEvent();
    const pending = await inbound.insertDelivery({
      inboundEventId: pendingEvent,
      workspaceId,
      mailboxId: mailbox.id,
      routeRule: "relay",
      acceptedPolicyVersion: 1,
    });
    await inbound.recordFetched(pending.deliveryId, fetchedContent({ rfcMessageId: unreservedId }));

    expect(await inbound.findForwardReservations(mailbox.id, [parentId, unreservedId])).toEqual([
      { deliveryId: parentDelivery, rfcMessageId: parentId, conversationId: parent.conversationId, state: "resolved" },
    ]);
    expect(await inbound.findForwardReservations(mailbox.id, [])).toEqual([]);

    const childDelivery = await reservedDelivery(mailbox, {
      rfcMessageId: childId,
      referenceIds: [rootId, parentId],
      conversationId: randomUUID(),
    });
    expect(await inbound.recordIngested(childDelivery, parent)).toBe(true);
    expect(await inbound.recordIngested(childDelivery, parent)).toBe(false);
    expect(await inbound.findReverseReferences(mailbox.id, rootId)).toEqual([
      { deliveryId: childDelivery, conversationId: parent.conversationId, state: "ingested" },
    ]);
    expect(await inbound.findReverseReferences(otherMailbox.id, rootId)).toEqual([]);
    expect(await inbound.settleDelivery(childDelivery, { state: "done", errorCode: null })).toBe(true);
    expect(await inbound.settleDelivery(childDelivery, { state: "failed", errorCode: "late" })).toBe(false);
    expect((await inbound.findReverseReferences(mailbox.id, parentId)).map((match) => match.state)).toEqual(["done"]);

    const threadToken = token();
    const link = await threads.upsertLink({
      conversationId: parent.conversationId,
      workspaceId,
      mailboxId: mailbox.id,
      threadKey: randomUUID(),
      threadToken,
      participantAddress: "person@example.org",
    });
    const again = await threads.upsertLink({ ...link, threadKey: randomUUID(), threadToken: token() });
    expect(again.threadKey).toBe(link.threadKey);

    const indexEntry = {
      workspaceId,
      mailboxId: mailbox.id,
      conversationId: parent.conversationId,
      subject: "Question",
      ccAddresses: ["cc@example.org"],
      attachments: [{ name: "invoice.pdf", contentType: "application/pdf", sizeBytes: 1200 }],
    };
    const indexed = [
      { ...indexEntry, messageId: parent.messageId, direction: "inbound" as const, origin: "inbound" as const, rfcMessageId: parentId, inboundDeliveryId: parentDelivery },
      { ...indexEntry, messageId: null, direction: "referenced" as const, origin: "referenced" as const, rfcMessageId: rootId, inboundDeliveryId: null },
    ];
    expect(await threads.insertIndexEntries(indexed)).toBe(2);
    expect(await threads.insertIndexEntries(indexed)).toBe(0);
    expect(await threads.findIndexedConversations(mailbox.id, [rootId, childId])).toEqual([
      { rfcMessageId: rootId, conversationId: parent.conversationId },
    ]);
    expect(await threads.findIndexedConversations(otherMailbox.id, [rootId])).toEqual([]);
    const listed = await threads.listIndexedMessages(parent.conversationId);
    expect(listed.map((entry) => [entry.rfcMessageId, entry.direction, entry.inboundDeliveryId, entry.attachments]).sort()).toEqual([
      [parentId, "inbound", parentDelivery, indexEntry.attachments],
      [rootId, "referenced", null, indexEntry.attachments],
    ].sort());

    expect((await threads.findLinkByThreadToken(mailbox.id, threadToken))?.conversationId).toBe(parent.conversationId);
    expect(await threads.findLinkByThreadToken(otherMailbox.id, threadToken)).toBeNull();
    expect(await threads.participantsOf([parent.conversationId, elsewhere.conversationId])).toEqual(
      new Map([[parent.conversationId, "person@example.org"]]),
    );

    const newer = new Date();
    expect(await threads.recordLatestInbound(parent.conversationId, {
      subject: "Re: Question",
      participantDisplayName: "Person",
      ccAddresses: ["cc@example.org"],
      inboundAt: newer,
    })).toBe(true);
    expect(await threads.recordLatestInbound(parent.conversationId, {
      subject: "Older",
      participantDisplayName: null,
      ccAddresses: [],
      inboundAt: new Date(newer.getTime() - HOUR_MS),
    })).toBe(false);
    expect(await threads.findLink(parent.conversationId)).toMatchObject({ latestSubject: "Re: Question", latestCcAddresses: ["cc@example.org"] });
  });

  it("schedules reviews by revision and completes only the revision that ran", async () => {
    const { workspaceId, mailbox } = await seedMailbox();
    const { conversationId } = await insertConversation(workspaceId);
    await threads.upsertLink({
      conversationId,
      workspaceId,
      mailboxId: mailbox.id,
      threadKey: randomUUID(),
      threadToken: token(),
      participantAddress: "person@example.org",
    });
    const firstDue = new Date(Date.now() + 60_000);
    expect(await threads.scheduleReview(conversationId, { dueAt: firstDue, policyVersion: 1 })).toEqual({ revision: 1, dueAt: firstDue });
    expect(await threads.scheduleReview(conversationId, { dueAt: new Date(Date.now() + 120_000), policyVersion: 2 }))
      .toEqual({ revision: 2, dueAt: firstDue });
    expect(await threads.completeReview(conversationId, 1)).toBe(false);
    expect(await threads.completeReview(conversationId, 2)).toBe(true);
    expect(await threads.findLink(conversationId)).toMatchObject({
      reviewRevision: 2,
      reviewCompletedRevision: 2,
      reviewDueAt: null,
      reviewPolicyVersion: 2,
    });
  });

  it("pages a mailbox's event log newest first with a stable cursor, filters, and counts", async () => {
    const { workspaceId, domain, mailbox } = await seedMailbox();
    const otherMailbox = await createMailbox(workspaceId, domain, { local: "sales" });
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const eventId = await insertEvent();
      const { deliveryId } = await inbound.insertDelivery({
        inboundEventId: eventId,
        workspaceId,
        mailboxId: mailbox.id,
        routeRule: "relay",
        acceptedPolicyVersion: 1,
        ...(index % 2 === 0 ? { settled: { disposition: "drop" as const, dispositionReason: "automated_sender" as const } } : {}),
      });
      created.push(deliveryId);
    }
    await inbound.recordFetched(created[1], fetchedContent({ rfcMessageId: "<log@example.org>", raw: true }));
    await inbound.settleDelivery(created[3], { state: "failed", errorCode: "fetch_failed" });
    // Two rows share a timestamp, so the id breaks the tie.
    const base = Date.now();
    for (const [index, deliveryId] of created.entries()) {
      const minutesAgo = index === 2 ? 30 : 60 - index * 10;
      await database.execute("UPDATE email_inbound_deliveries SET created_at = $2 WHERE id = $1", [
        deliveryId,
        new Date(base - minutesAgo * 60 * 1000),
      ]);
    }
    await inbound.insertDelivery({
      inboundEventId: await insertEvent(),
      workspaceId,
      mailboxId: otherMailbox.id,
      routeRule: "relay",
      acceptedPolicyVersion: 1,
    });

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const page = await inbound.listMailboxLog(mailbox.id, { cursor, limit: 2, disposition: null, states: null });
      pages.push(page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);
    const expectedOrder = [created[4], ...[created[2], created[3]].sort().reverse(), created[1], created[0]];
    expect(pages.flat()).toEqual(expectedOrder);
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);

    const firstPage = await inbound.listMailboxLog(mailbox.id, { cursor: null, limit: 10, disposition: null, states: null });
    expect(firstPage.nextCursor).toBeNull();
    expect(firstPage.entries.find((entry) => entry.id === created[1])).toMatchObject({
      state: "fetched",
      senderAddress: "person@example.org",
      hasRaw: true,
      authResults: { spf: "pass", dkim: "pass", dmarc: "pass" },
    });
    expect(firstPage.entries.find((entry) => entry.id === created[0])).toMatchObject({ hasRaw: false, disposition: "drop" });

    const drops = await inbound.listMailboxLog(mailbox.id, { cursor: null, limit: 10, disposition: "drop", states: null });
    expect(drops.entries.map((entry) => entry.id).sort()).toEqual([created[0], created[2], created[4]].sort());
    const failed = await inbound.listMailboxLog(mailbox.id, { cursor: null, limit: 10, disposition: null, states: ["failed"] });
    expect(failed.entries.map((entry) => entry.id)).toEqual([created[3]]);

    expect(await inbound.countMailboxEvents(mailbox.id, new Date(Date.now() - 2 * HOUR_MS))).toEqual({
      byDisposition: { drop: 3, undecided: 2 },
      failed: 1,
    });
    expect(await inbound.countMailboxEvents(mailbox.id, new Date(Date.now() - 45 * 60 * 1000))).toEqual({
      byDisposition: { drop: 2, undecided: 1 },
      failed: 1,
    });
  });

  it("purges only conversation-less deliveries past retention, and the settled events they leave behind", async () => {
    const { workspaceId, mailbox } = await seedMailbox();
    const conversation = await insertConversation(workspaceId);
    const deliveryFor = async (state: "pending" | "processed") => {
      const eventId = await insertEvent();
      await database.execute("UPDATE email_inbound_events SET state = $2 WHERE id = $1", [eventId, state]);
      const { deliveryId } = await inbound.insertDelivery({
        inboundEventId: eventId,
        workspaceId,
        mailboxId: mailbox.id,
        routeRule: "relay",
        acceptedPolicyVersion: 1,
      });
      return { eventId, deliveryId };
    };
    const oldDropped = await deliveryFor("processed");
    const oldAttached = await deliveryFor("processed");
    const oldInFlightEvent = await deliveryFor("pending");
    const recent = await deliveryFor("processed");
    await database.execute("UPDATE email_inbound_deliveries SET conversation_id = $2 WHERE id = $1", [
      oldAttached.deliveryId,
      conversation.conversationId,
    ]);
    for (const { eventId, deliveryId } of [oldDropped, oldAttached, oldInFlightEvent]) {
      await database.execute("UPDATE email_inbound_deliveries SET created_at = now() - interval '40 days' WHERE id = $1", [deliveryId]);
      await database.execute("UPDATE email_inbound_events SET received_at = now() - interval '40 days' WHERE id = $1", [eventId]);
    }

    const cutoff = new Date(Date.now() - 30 * 24 * HOUR_MS);
    expect(await inbound.purgeUnattachedBefore(cutoff, 100)).toEqual({ deliveries: 2, events: 1 });

    const remainingDeliveries = await database.query<{ id: string }>(
      "SELECT id FROM email_inbound_deliveries WHERE id = ANY($1::uuid[])",
      [[oldDropped.deliveryId, oldAttached.deliveryId, oldInFlightEvent.deliveryId, recent.deliveryId]],
    );
    expect(remainingDeliveries.map((row) => row.id).sort()).toEqual([oldAttached.deliveryId, recent.deliveryId].sort());
    const remainingEvents = await database.query<{ id: string }>(
      "SELECT id FROM email_inbound_events WHERE id = ANY($1::uuid[])",
      [[oldDropped.eventId, oldAttached.eventId, oldInFlightEvent.eventId, recent.eventId]],
    );
    expect(remainingEvents.map((row) => row.id).sort()).toEqual([oldAttached.eventId, oldInFlightEvent.eventId, recent.eventId].sort());
  });

  it("serializes thread resolution per mailbox and participant inside a transaction", async () => {
    const mailboxId = randomUUID();
    const key = { mailboxId, participantAddress: "Person@Example.org" };
    await expect(lockThreadResolution(database.kysely, key)).rejects.toThrow("inside a transaction");

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holder = database.kysely.transaction().execute(async (trx) => {
      await lockThreadResolution(trx, key);
      signalLocked();
      await held;
    });
    await locked;

    const tryLock = async (lockKey: string) => {
      const client = new pg.Client({ connectionString: testDatabaseUrl });
      await client.connect();
      try {
        const result = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
          [lockKey],
        );
        return result.rows[0]?.acquired ?? false;
      } finally {
        await client.end();
      }
    };
    expect(await tryLock(threadResolutionLockKey({ mailboxId, participantAddress: "person@example.org" }))).toBe(false);
    expect(await tryLock(threadResolutionLockKey({ mailboxId, participantAddress: "other@example.org" }))).toBe(true);
    expect(threadResolutionLockKey(key)).not.toContain("example.org");

    release();
    await holder;
    expect(await tryLock(threadResolutionLockKey(key))).toBe(true);
  });
});
