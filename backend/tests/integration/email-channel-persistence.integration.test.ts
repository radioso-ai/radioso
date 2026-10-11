import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createPostgresMailboxPolicyChangeUnitOfWork } from "../../src/app/composition/mailboxPolicyChange.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import {
  EmailDomainRepository,
  EmailInboundRepository,
  EmailMailboxRepository,
  EmailThreadRepository,
  lockThreadResolution,
  SendingDomainService,
} from "../../src/modules/emailChannel/public.js";
import type { DomainReadiness, EmailDomainProvisioner } from "../../src/modules/mail/public.js";
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

  /** Claims the event as a drain would: `processing`, its attempt counted, under a lease. */
  const claimEvent = async (eventId: string): Promise<number> =>
    (await database.queryOne<{ attempts: number }>(
      `UPDATE email_inbound_events SET state = 'processing', attempts = attempts + 1, lease_until = now() + interval '1 minute'
        WHERE id = $1 RETURNING attempts`,
      [eventId],
    )).attempts;

  /** The claim a delivery's writes are made under: its event's current one. */
  const claimOf = async (deliveryId: string) => ({
    deliveryId,
    attempt: (await database.queryOne<{ attempts: number }>(
      "SELECT e.attempts FROM email_inbound_events e JOIN email_inbound_deliveries d ON d.inbound_event_id = e.id WHERE d.id = $1",
      [deliveryId],
    )).attempts,
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
    const claim = { deliveryId, attempt: await claimEvent(eventId) };
    expect(await inbound.recordFetched(claim, fetchedContent(input))).toBe(true);
    expect(await inbound.reserveThread(claim, {
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

  const domainRegistration = (domain: string, providerDomainId = `p-${domain}`) => ({
    providerDomainId,
    providerRegion: "eu-west-1",
    dnsRecords: [{ purpose: "dkim" as const, type: "TXT" as const, name: `resend._domainkey.${domain}`, value: "p=abc", status: "pending" as const }],
    sendingStatus: "pending" as const,
    receivingStatus: "not_requested" as const,
    nextCheckAt: new Date(Date.now() + HOUR_MS),
  });

  const heldClaim = async (workspaceId: string, domain: string) => {
    const claim = await domains.claim({ workspaceId, domain, provider: "resend", createdByUserId: null });
    if (claim.status !== "held") throw new Error(`expected a claim, got ${claim.status}`);
    return claim.domain;
  };

  /**
   * Another connection's transaction that takes `lock`'s row locks, then, once `release` names a
   * statement, runs it and commits. Resolves once the locks are held.
   */
  const holdingLocks = async (lock: string, params: unknown[], release: Promise<string>) => {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(lock, params);
    const committed = (async () => {
      await client.query(await release, params);
      await client.query("COMMIT");
      client.release();
      await pool.end();
    })();
    return { committed };
  };

  const stillPending = async (work: Promise<unknown>) => {
    const settled = await Promise.race([work.then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 200))]);
    return settled === false;
  };

  it("claims a domain for one workspace at a time and records the provider's registration on the claim only", async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const domain = uniqueDomain();

    const [a, b] = await Promise.all([heldClaim(first.workspaceId, domain), heldClaim(second.workspaceId, domain)]);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ providerDomainId: null, registrationStatus: "registering", sendingStatus: "pending", nextCheckAt: null, dnsRecords: [] });
    expect((await domains.listDueForRefresh(1000)).map((record) => record.id)).not.toContain(a.id);

    const registration = domainRegistration(domain);
    expect(await domains.recordRegistration(a.id, registration)).toMatchObject({
      providerDomainId: `p-${domain}`,
      providerRegion: "eu-west-1",
      registrationStatus: "registered",
    });
    expect(await domains.recordRegistration(a.id, { ...registration, providerDomainId: "other" })).toBeNull();
    await domains.releaseClaim(a.id);
    expect((await domains.findById(a.id))?.providerDomainId).toBe(`p-${domain}`);
    await expect(database.execute("UPDATE email_domains SET provider_domain_id = NULL WHERE id = $1", [a.id]))
      .rejects.toMatchObject({ code: "23514" });

    const unfinished = await heldClaim(second.workspaceId, uniqueDomain());
    expect(await domains.markNeedsReconciliation(unfinished.id)).toMatchObject({ registrationStatus: "needs_reconciliation", providerDomainId: null });
    expect(await domains.markNeedsReconciliation(unfinished.id)).toBeNull();
    expect(await domains.recordRegistration(unfinished.id, domainRegistration(unfinished.domain))).toMatchObject({ registrationStatus: "registered" });
    const released = await heldClaim(second.workspaceId, uniqueDomain());
    await domains.releaseClaim(released.id);
    expect(await domains.findById(released.id)).toBeNull();
  });

  it("refuses a claim and an adoption of a name while its removal is cleaned up, and only then", async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const domain = uniqueDomain();
    const removed = await createDomain(first.workspaceId, domain);
    await domains.markRemoved(first.workspaceId, removed.id);
    const claimBy = (workspaceId: string) => domains.claim({ workspaceId, domain, provider: "local", createdByUserId: null });

    expect(await domains.isRemovalPending(domain)).toBe(true);
    expect(await claimBy(second.workspaceId)).toEqual({ status: "removal_pending" });
    expect(await claimBy(first.workspaceId)).toEqual({ status: "removal_pending" });
    // A claim taken while the removal committed, waiting for reconciliation.
    const [{ id: claimId }] = await database.query<{ id: string }>(
      "INSERT INTO email_domains (workspace_id, domain, provider, registration_status) VALUES ($1, $2, 'local', 'needs_reconciliation') RETURNING id",
      [second.workspaceId, domain],
    );
    const found = domainRegistration(domain, removed.providerDomainId!);
    expect(await domains.adoptRegistration(claimId, found)).toEqual({ status: "removal_pending" });

    await domains.recordCleanup(removed.id, { status: "failed", retryAt: new Date(Date.now() + HOUR_MS), providerDomainId: removed.providerDomainId });
    expect(await domains.adoptRegistration(claimId, found)).toEqual({ status: "removal_pending" });
    await domains.recordCleanup(removed.id, { status: "done", retryAt: null, providerDomainId: removed.providerDomainId });
    expect(await domains.isRemovalPending(domain)).toBe(false);
    // `done` is final: a stale attempt's failure does not reopen the removal.
    await domains.recordCleanup(removed.id, { status: "failed", retryAt: null, providerDomainId: removed.providerDomainId });
    expect((await domains.findById(removed.id))?.providerCleanupStatus).toBe("done");

    const adopted = await domains.adoptRegistration(claimId, domainRegistration(domain, "p-fresh"));
    expect(adopted).toMatchObject({ status: "adopted", domain: { id: claimId, providerDomainId: "p-fresh", registrationStatus: "registered" } });
    expect(await domains.adoptRegistration(claimId, found)).toEqual({ status: "not_awaiting" });
    expect(await domains.adoptRegistration(randomUUID(), found)).toEqual({ status: "not_awaiting" });
  });

  it("decides a claim and an adoption after a concurrent removal or cleanup transition commits, under the name's row locks", async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const domain = uniqueDomain();
    const active = await createDomain(first.workspaceId, domain);

    // A claim that meets the active row while its removal is committing waits, then sees the removal.
    let commitRemoval!: (statement: string) => void;
    const removing = await holdingLocks(
      "SELECT id FROM email_domains WHERE id = $1 FOR UPDATE",
      [active.id],
      new Promise<string>((resolve) => { commitRemoval = resolve; }),
    );
    const claiming = domains.claim({ workspaceId: second.workspaceId, domain, provider: "local", createdByUserId: null });
    expect(await stillPending(claiming)).toBe(true);
    commitRemoval("UPDATE email_domains SET removed_at = now(), provider_cleanup_status = 'pending' WHERE id = $1");
    await removing.committed;
    expect(await claiming).toEqual({ status: "removal_pending" });

    const [{ id: claimId }] = await database.query<{ id: string }>(
      "INSERT INTO email_domains (workspace_id, domain, provider, registration_status) VALUES ($1, $2, 'local', 'needs_reconciliation') RETURNING id",
      [second.workspaceId, domain],
    );
    const found = domainRegistration(domain, active.providerDomainId!);

    // An adoption that meets a cleanup mid-transition waits for it: still removing, it is refused.
    let commitCleanup!: (statement: string) => void;
    let cleaning = await holdingLocks(
      "SELECT id FROM email_domains WHERE id = $1 FOR UPDATE",
      [active.id],
      new Promise<string>((resolve) => { commitCleanup = resolve; }),
    );
    let adopting = domains.adoptRegistration(claimId, found);
    expect(await stillPending(adopting)).toBe(true);
    commitCleanup("UPDATE email_domains SET provider_cleanup_status = 'failed' WHERE id = $1");
    await cleaning.committed;
    expect(await adopting).toEqual({ status: "removal_pending" });

    // Once the cleanup commits `done`, the waiting adoption goes ahead.
    cleaning = await holdingLocks(
      "SELECT id FROM email_domains WHERE id = $1 FOR UPDATE",
      [active.id],
      new Promise<string>((resolve) => { commitCleanup = resolve; }),
    );
    adopting = domains.adoptRegistration(claimId, domainRegistration(domain, "p-fresh"));
    expect(await stillPending(adopting)).toBe(true);
    commitCleanup("UPDATE email_domains SET provider_cleanup_status = 'done' WHERE id = $1");
    await cleaning.committed;
    expect(await adopting).toMatchObject({ status: "adopted", domain: { providerDomainId: "p-fresh" } });
  });

  it("hands a registration answered after its claim was removed to that claim's cleanup, until the cleanup finishes", async () => {
    const { workspaceId } = await seedWorkspace();
    const claim = await heldClaim(workspaceId, uniqueDomain());
    await domains.markRemoved(workspaceId, claim.id);

    // A cleanup attempt that read the claim before the registration arrived settles nothing.
    expect(await domains.recordRemovedClaimRegistration(claim.id, { providerDomainId: "p-late", providerRegion: "eu-west-1" })).toBe(true);
    await domains.recordCleanup(claim.id, { status: "done", retryAt: null, providerDomainId: null });
    expect(await domains.findById(claim.id)).toMatchObject({
      providerDomainId: "p-late",
      registrationStatus: "registered",
      providerCleanupStatus: "pending",
    });
    expect((await domains.listCleanupDue(1000)).map((record) => record.id)).toContain(claim.id);
    await domains.recordCleanup(claim.id, { status: "done", retryAt: null, providerDomainId: "p-late" });
    expect((await domains.findById(claim.id))?.providerCleanupStatus).toBe("done");

    const settled = await heldClaim(workspaceId, uniqueDomain());
    await domains.markRemoved(workspaceId, settled.id);
    await domains.recordCleanup(settled.id, { status: "done", retryAt: null, providerDomainId: null });
    expect(await domains.recordRemovedClaimRegistration(settled.id, { providerDomainId: "p-orphan", providerRegion: null })).toBe(false);
    expect((await domains.findById(settled.id))?.providerDomainId).toBeNull();
  });

  it("waits for an operator's reconcile when the provider already holds a claimed name, and adopts it only then", async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const domain = uniqueDomain();
    const readiness: DomainReadiness = {
      sending: "pending",
      receiving: "not_requested",
      records: [{ purpose: "dkim", type: "TXT", name: `resend._domainkey.${domain}`, value: "p=abc", status: "pending" }],
    };
    // The provider account: one registration per name.
    const held = new Set<string>();
    const providerDomainOf = (name: string) => ({ providerDomainId: `p-${name}`, region: "eu-west-1", readiness });
    const provisioner = {
      provider: "resend",
      registerSendingDomain: vi.fn<EmailDomainProvisioner["registerSendingDomain"]>(async (name) => {
        if (held.has(name)) return { ok: false, refused: "already_registered" };
        held.add(name);
        return { ok: true, ...providerDomainOf(name) };
      }),
      findByName: vi.fn<EmailDomainProvisioner["findByName"]>(async (name) => (held.has(name) ? providerDomainOf(name) : null)),
      enableReceiving: vi.fn<EmailDomainProvisioner["enableReceiving"]>(async () => readiness),
      requestVerification: vi.fn<EmailDomainProvisioner["requestVerification"]>(async () => undefined),
      readiness: vi.fn<EmailDomainProvisioner["readiness"]>(async () => readiness),
      remove: vi.fn<EmailDomainProvisioner["remove"]>(async () => undefined),
    };
    const service = new SendingDomainService({
      domains,
      mailboxes,
      provisioner,
      audit: { record: async () => undefined },
      logger: { warn: () => undefined },
      metrics: null,
      clock: () => new Date(),
      inboundDomain: "in.radioso.test",
    });
    const actor = { userId: null, accountId: null };

    // Accepted by the provider, answer lost on the way back.
    provisioner.registerSendingDomain.mockImplementationOnce(async (name) => {
      held.add(name);
      throw new Error("socket hang up");
    });
    await expect(service.ensureRegistered(actor, first.workspaceId, domain)).rejects.toMatchObject({ code: "provider_unavailable" });
    const claim = await domains.findActiveByDomain(domain);
    expect(claim).toMatchObject({ workspaceId: first.workspaceId, providerDomainId: null, registrationStatus: "registering" });
    expect(await service.ensureRegistered(actor, second.workspaceId, domain)).toEqual({ ok: false, refused: "claimed_elsewhere" });

    await expect(service.ensureRegistered(actor, first.workspaceId, domain)).rejects.toMatchObject({ code: "domain_needs_reconciliation" });
    expect(await domains.findById(claim!.id)).toMatchObject({ registrationStatus: "needs_reconciliation", providerDomainId: null });
    expect(provisioner.findByName).not.toHaveBeenCalled();

    expect(await service.reconcile(actor, first.workspaceId, claim!.id)).toMatchObject({ id: claim!.id, registration: { status: "registered" } });
    expect(await domains.findById(claim!.id)).toMatchObject({ providerDomainId: `p-${domain}` });
    expect(await service.ensureRegistered(actor, first.workspaceId, domain)).toMatchObject({ ok: true, domain: { id: claim!.id } });
    expect(await service.ensureRegistered(actor, second.workspaceId, domain)).toEqual({ ok: false, refused: "claimed_elsewhere" });
  });

  it("refreshes readiness when due, confirms receiving, and leaves removed domains for asynchronous cleanup", async () => {
    const { workspaceId } = await seedWorkspace();
    const domain = await createDomain(workspaceId);
    await database.execute("UPDATE email_domains SET next_check_at = now() - interval '1 minute' WHERE id = $1", [domain.id]);
    expect((await domains.listDueForRefresh(100)).map((record) => record.id)).toContain(domain.id);
    await domains.deferRefresh(domain.id, new Date(Date.now() + HOUR_MS), domain.refreshRequestedVersion);
    expect((await domains.listDueForRefresh(100)).map((record) => record.id)).not.toContain(domain.id);
    expect((await domains.findById(domain.id))?.lastCheckedAt?.getTime()).toBe(domain.lastCheckedAt?.getTime());
    await database.execute("UPDATE email_domains SET next_check_at = now() - interval '1 minute' WHERE id = $1", [domain.id]);

    const verifiedReading = {
      sendingStatus: "verified" as const,
      receivingStatus: "not_requested" as const,
      dnsRecords: [{ purpose: "dkim" as const, type: "TXT" as const, name: "k", value: "v", status: "verified" as const }],
      nextCheckAt: new Date(Date.now() + 24 * HOUR_MS),
      statusChanged: true,
      requestedVersion: domain.refreshRequestedVersion,
    };
    const verified = await domains.recordReadiness(domain.id, verifiedReading);
    expect(verified).toMatchObject({ sendingStatus: "verified", dnsRecords: [{ status: "verified" }] });
    expect((await domains.listDueForRefresh(100)).map((record) => record.id)).not.toContain(domain.id);

    const confirmed = await domains.confirmReceiving(domain.id, {
      confirmedByUserId: null,
      readiness: {
        sendingStatus: "verified",
        receivingStatus: "verified",
        dnsRecords: [],
        nextCheckAt: new Date(Date.now() + HOUR_MS),
        statusChanged: true,
        requestedVersion: domain.refreshRequestedVersion,
      },
    });
    expect(confirmed?.receivingConfirmedAt).toBeInstanceOf(Date);
    expect(await domains.findReceivingVerified(domain.domain)).toEqual({ workspaceId });

    await domains.markRemoved(workspaceId, domain.id);
    expect(await domains.findReceivingVerified(domain.domain)).toBeNull();
    expect((await domains.listCleanupDue(100)).map((record) => record.id)).toContain(domain.id);
    await domains.recordCleanup(domain.id, { status: "failed", retryAt: new Date(Date.now() + HOUR_MS), providerDomainId: domain.providerDomainId });
    expect((await domains.listCleanupDue(100)).map((record) => record.id)).not.toContain(domain.id);
    await domains.recordCleanup(domain.id, { status: "done", retryAt: null, providerDomainId: domain.providerDomainId });
    expect((await domains.findById(domain.id))?.providerCleanupStatus).toBe("done");
    expect((await domains.listCleanupDue(100)).map((record) => record.id)).not.toContain(domain.id);
  });

  it("keeps a refresh request that arrives while a refresh reads the provider, including a readiness revocation", async () => {
    const { workspaceId } = await seedWorkspace();
    const domain = await createDomain(workspaceId);
    await database.execute("UPDATE email_domains SET sending_status = 'verified', next_check_at = now() - interval '1 minute' WHERE id = $1", [domain.id]);
    const [read] = (await domains.listDueForRefresh(1000)).filter((record) => record.id === domain.id);
    expect(read?.refreshRequestedVersion).toBe(0);

    // The provider reports the revocation after the refresh read it.
    expect(await domains.expediteRefresh({ provider: "local", providerDomainId: domain.providerDomainId! })).toBe(true);
    const stale = {
      sendingStatus: "verified" as const,
      receivingStatus: "not_requested" as const,
      dnsRecords: [],
      nextCheckAt: new Date(Date.now() + 24 * HOUR_MS),
      statusChanged: false,
      requestedVersion: read.refreshRequestedVersion,
    };
    expect(await domains.recordReadiness(domain.id, stale)).toBeNull();
    await domains.deferRefresh(domain.id, new Date(Date.now() + HOUR_MS), read.refreshRequestedVersion);
    const [due] = (await domains.listDueForRefresh(1000)).filter((record) => record.id === domain.id);
    expect(due).toMatchObject({ refreshRequestedVersion: 1, sendingStatus: "verified" });

    // The next refresh reads past the event and records the revocation.
    const revoked = await domains.recordReadiness(domain.id, {
      ...stale,
      sendingStatus: "failed",
      nextCheckAt: new Date(Date.now() + 6 * HOUR_MS),
      statusChanged: true,
      requestedVersion: due.refreshRequestedVersion,
    });
    expect(revoked).toMatchObject({ sendingStatus: "failed", refreshRequestedVersion: 1 });
    expect((await domains.listDueForRefresh(1000)).map((record) => record.id)).not.toContain(domain.id);

    // A receiving confirmation always lands; an event since its read keeps the domain due.
    await domains.expediteRefresh({ provider: "local", providerDomainId: domain.providerDomainId! });
    const confirmed = await domains.confirmReceiving(domain.id, {
      confirmedByUserId: null,
      readiness: { ...stale, receivingStatus: "pending", requestedVersion: 1 },
    });
    expect(confirmed).toMatchObject({ receivingStatus: "pending", refreshRequestedVersion: 2 });
    expect(confirmed?.receivingConfirmedAt).toBeInstanceOf(Date);
    expect((await domains.listDueForRefresh(1000)).map((record) => record.id)).toContain(domain.id);
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
    const changes = createPostgresMailboxPolicyChangeUnitOfWork({
      db: database.kysely,
      activity: new ConversationActivityRepository(database.kysely),
      ownership: { requestHumanOwnership: () => Promise.reject(new Error("this suite supersedes no draft")) },
    });

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

  it("fences each delivery step on its event's claim: a reclaimed worker's write lands nowhere", async () => {
    const { mailbox } = await seedMailbox();
    const eventId = await insertEvent();
    const { deliveryId } = await inbound.insertDelivery({
      inboundEventId: eventId,
      workspaceId: mailbox.workspaceId,
      mailboxId: mailbox.id,
      routeRule: "relay",
      acceptedPolicyVersion: 1,
    });
    const content = fetchedContent({ rfcMessageId: `<fenced.${randomUUID()}@example.org>` });
    // Not claimed yet: no worker's write lands.
    expect(await inbound.recordFetched({ deliveryId, attempt: 0 }, content)).toBe(false);

    const stale = { deliveryId, attempt: await claimEvent(eventId) };
    const current = { deliveryId, attempt: await claimEvent(eventId) };
    expect(await inbound.recordFetched(stale, content)).toBe(false);
    expect(await inbound.recordFetched(current, content)).toBe(true);
    const ingested = await insertConversation(mailbox.workspaceId);
    const reservation = {
      threadMatch: "new_thread" as const,
      threadConflict: false,
      disposition: "run_review_turn" as const,
      dispositionReason: "accepted" as const,
      plannedConversationId: ingested.conversationId,
      plannedMessageId: ingested.messageId,
      plannedThreadKey: randomUUID(),
      plannedThreadToken: token(),
    };
    expect(await inbound.reserveThread(stale, reservation)).toBe(false);
    expect(await inbound.settleDropped(stale, { threadMatch: null, threadConflict: false, dispositionReason: "spam" })).toBe(false);
    expect(await inbound.reserveThread(current, reservation)).toBe(true);
    const ids = { conversationId: ingested.conversationId, messageId: ingested.messageId };
    expect(await inbound.recordIngested(stale, ids)).toBe(false);
    expect(await inbound.recordIngested(current, ids)).toBe(true);
    expect(await inbound.markIndexed(stale)).toBe(false);
    expect(await inbound.failDelivery(stale, "processing_failed")).toBe(false);
    expect(await inbound.markIndexed(current)).toBe(true);
    expect(await inbound.markIndexed(current)).toBe(false);

    // A settled event takes no more writes, even from the claim that settled it.
    const settledEvent = await insertEvent();
    const { deliveryId: settledDelivery } = await inbound.insertDelivery({
      inboundEventId: settledEvent,
      workspaceId: mailbox.workspaceId,
      mailboxId: mailbox.id,
      routeRule: "relay",
      acceptedPolicyVersion: 1,
    });
    const attempt = await claimEvent(settledEvent);
    expect(await inbound.settleEvent(settledEvent, { attempt, state: "processed", errorCode: null })).toBe(true);
    expect(await inbound.failDelivery({ deliveryId: settledDelivery, attempt }, "processing_failed")).toBe(false);
  });

  it("upgrades a referenced Message-ID placeholder of the same conversation to the message's own entry, and only that", async () => {
    const { workspaceId, domain, mailbox } = await seedMailbox();
    const otherMailbox = await createMailbox(workspaceId, domain, { local: "billing" });
    const conversation = await insertConversation(workspaceId);
    const elsewhere = await insertConversation(workspaceId);
    const parentId = `<parent.${randomUUID()}@example.org>`;
    const seenId = `<seen.${randomUUID()}@example.org>`;
    const placeholder = (conversationId: string, rfcMessageId: string, mailboxId = mailbox.id) => ({
      workspaceId,
      mailboxId,
      conversationId,
      messageId: null,
      direction: "referenced" as const,
      origin: "referenced" as const,
      rfcMessageId,
      subject: null,
      ccAddresses: [],
      attachments: [],
      inboundDeliveryId: null,
    });
    const parentDelivery = await reservedDelivery(mailbox, { rfcMessageId: parentId, conversationId: conversation.conversationId });
    const actual = (conversationId: string, rfcMessageId: string) => ({
      workspaceId,
      mailboxId: mailbox.id,
      conversationId,
      messageId: conversation.messageId,
      direction: "inbound" as const,
      origin: "inbound" as const,
      rfcMessageId,
      subject: "Order 1234",
      ccAddresses: ["cc@example.org"],
      attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 900 }],
      inboundDeliveryId: parentDelivery,
    });

    // The follow-up came first and only referenced the parent; then the parent itself is indexed.
    expect(await threads.insertIndexEntries([placeholder(conversation.conversationId, parentId)])).toBe(1);
    expect(await threads.insertIndexEntries([actual(conversation.conversationId, parentId)])).toBe(1);
    expect((await threads.listIndexedMessages(conversation.conversationId)).find((entry) => entry.rfcMessageId === parentId)).toMatchObject({
      messageId: conversation.messageId,
      direction: "inbound",
      origin: "inbound",
      subject: "Order 1234",
      ccAddresses: ["cc@example.org"],
      attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 900 }],
      inboundDeliveryId: parentDelivery,
    });
    expect(await threads.findLatestInboundThreading(conversation.conversationId)).toMatchObject({ rfcMessageId: parentId });

    // A real entry is never overwritten, by a placeholder or by another real entry.
    expect(await threads.insertIndexEntries([placeholder(conversation.conversationId, parentId)])).toBe(0);
    expect(await threads.insertIndexEntries([{ ...actual(conversation.conversationId, parentId), subject: "Rewritten" }])).toBe(0);
    expect((await threads.listIndexedMessages(conversation.conversationId)).find((entry) => entry.rfcMessageId === parentId))
      .toMatchObject({ direction: "inbound", subject: "Order 1234" });

    // Another conversation's placeholder keeps its thread: a conflict is not resolved by overwriting.
    expect(await threads.insertIndexEntries([placeholder(elsewhere.conversationId, seenId)])).toBe(1);
    expect(await threads.insertIndexEntries([actual(conversation.conversationId, seenId)])).toBe(0);
    expect(await threads.findIndexedConversations(mailbox.id, [seenId])).toEqual([{ rfcMessageId: seenId, conversationId: elsewhere.conversationId }]);
    // Another mailbox indexes the same Message-ID on its own.
    expect(await threads.insertIndexEntries([placeholder(conversation.conversationId, parentId, otherMailbox.id)])).toBe(1);
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
    await claimEvent(pendingEvent);
    await inbound.recordFetched(await claimOf(pending.deliveryId), fetchedContent({ rfcMessageId: unreservedId }));

    expect(await inbound.findForwardReservations(mailbox.id, [parentId, unreservedId])).toEqual([
      { deliveryId: parentDelivery, rfcMessageId: parentId, conversationId: parent.conversationId, state: "resolved" },
    ]);
    expect(await inbound.findForwardReservations(mailbox.id, [])).toEqual([]);

    const childDelivery = await reservedDelivery(mailbox, {
      rfcMessageId: childId,
      referenceIds: [rootId, parentId],
      conversationId: randomUUID(),
    });
    const childClaim = await claimOf(childDelivery);
    expect(await inbound.recordIngested(childClaim, parent)).toBe(true);
    expect(await inbound.recordIngested(childClaim, parent)).toBe(false);
    expect(await inbound.findReverseReferences(mailbox.id, rootId)).toEqual([
      { deliveryId: childDelivery, conversationId: parent.conversationId, state: "ingested" },
    ]);
    expect(await inbound.findReverseReferences(otherMailbox.id, rootId)).toEqual([]);
    expect(await inbound.markIndexed(childClaim)).toBe(true);
    expect(await inbound.failDelivery(childClaim, "late")).toBe(false);
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
    await database.execute("UPDATE email_thread_links SET review_due_at = now() - interval '1 second' WHERE conversation_id = $1", [conversationId]);
    const claimed = (await threads.claimDueReviews({ limit: 100, leaseSeconds: 60 })).find((link) => link.conversationId === conversationId);
    if (!claimed) throw new Error("the review was not claimed");
    const claim = { conversationId, attempt: claimed.reviewAttempts, leaseUntil: claimed.reviewLeaseUntil };
    expect(await threads.holdsReviewClaim(claim)).toBe(true);
    expect(await threads.completeReview({ ...claim, revision: 1 })).toBe(false);
    // A claim whose lease was taken over completes nothing, even at the revision that ran.
    await database.execute("UPDATE email_thread_links SET review_lease_until = now() - interval '1 second' WHERE conversation_id = $1", [conversationId]);
    const takeover = (await threads.claimDueReviews({ limit: 100, leaseSeconds: 60 })).find((link) => link.conversationId === conversationId);
    if (!takeover) throw new Error("the review was not reclaimed");
    expect(await threads.holdsReviewClaim(claim)).toBe(false);
    expect(await threads.completeReview({ ...claim, revision: 2 })).toBe(false);
    expect(await threads.releaseReview(claim)).toBe(false);
    expect(await threads.completeReview({ conversationId, attempt: takeover.reviewAttempts, leaseUntil: takeover.reviewLeaseUntil, revision: 2 })).toBe(true);
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
    for (const deliveryId of [created[1], created[3]]) {
      await database.execute(
        "UPDATE email_inbound_events SET state = 'processing', attempts = 1 WHERE id = (SELECT inbound_event_id FROM email_inbound_deliveries WHERE id = $1)",
        [deliveryId],
      );
    }
    await inbound.recordFetched(await claimOf(created[1]), fetchedContent({ rfcMessageId: "<log@example.org>", raw: true }));
    await inbound.failDelivery(await claimOf(created[3]), "fetch_failed");
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

  it("purges only settled, conversation-less deliveries past retention, never an unfinished checkpoint, and the settled events they leave", async () => {
    await database.execute("DELETE FROM email_inbound_deliveries WHERE conversation_id IS NULL");
    const { workspaceId, mailbox } = await seedMailbox();
    const conversation = await insertConversation(workspaceId);
    const deliveryFor = async (event: "pending" | "processing" | "processed" | "failed", delivery: "pending" | "resolved" | "done" | "failed") => {
      const eventId = await insertEvent();
      await database.execute("UPDATE email_inbound_events SET state = $2 WHERE id = $1", [eventId, event]);
      const { deliveryId } = await inbound.insertDelivery({
        inboundEventId: eventId,
        workspaceId,
        mailboxId: mailbox.id,
        routeRule: "relay",
        acceptedPolicyVersion: 1,
      });
      await database.execute("UPDATE email_inbound_deliveries SET state = $2 WHERE id = $1", [deliveryId, delivery]);
      return { eventId, deliveryId };
    };
    const oldDropped = await deliveryFor("processed", "done");
    const oldFailed = await deliveryFor("failed", "failed");
    const oldAttached = await deliveryFor("processed", "done");
    // A worker died after the host's ingest committed and before the delivery recorded it, and
    // stayed down past retention: the reservation is the only thing keeping a retry from ingesting again.
    const oldCrashedCheckpoint = await deliveryFor("processing", "resolved");
    const oldPendingEvent = await deliveryFor("pending", "pending");
    // Reopened by an operator: the delivery settled, its event due again.
    const oldReopened = await deliveryFor("pending", "failed");
    const recent = await deliveryFor("processed", "done");
    await database.execute("UPDATE email_inbound_deliveries SET conversation_id = $2 WHERE id = $1", [
      oldAttached.deliveryId,
      conversation.conversationId,
    ]);
    const old = [oldDropped, oldFailed, oldAttached, oldCrashedCheckpoint, oldPendingEvent, oldReopened];
    for (const { eventId, deliveryId } of old) {
      await database.execute("UPDATE email_inbound_deliveries SET created_at = now() - interval '40 days' WHERE id = $1", [deliveryId]);
      await database.execute("UPDATE email_inbound_events SET received_at = now() - interval '40 days' WHERE id = $1", [eventId]);
    }

    const cutoff = new Date(Date.now() - 30 * 24 * HOUR_MS);
    expect(await inbound.purgeUnattachedBefore(cutoff, 100)).toEqual({ deliveries: 2, events: 2 });

    const all = [...old, recent];
    const remainingDeliveries = await database.query<{ id: string }>(
      "SELECT id FROM email_inbound_deliveries WHERE id = ANY($1::uuid[])",
      [all.map((entry) => entry.deliveryId)],
    );
    expect(remainingDeliveries.map((row) => row.id).sort()).toEqual(
      [oldAttached, oldCrashedCheckpoint, oldPendingEvent, oldReopened, recent].map((entry) => entry.deliveryId).sort(),
    );
    const remainingEvents = await database.query<{ id: string }>(
      "SELECT id FROM email_inbound_events WHERE id = ANY($1::uuid[])",
      [all.map((entry) => entry.eventId)],
    );
    expect(remainingEvents.map((row) => row.id).sort()).toEqual(
      [oldAttached, oldCrashedCheckpoint, oldPendingEvent, oldReopened, recent].map((entry) => entry.eventId).sort(),
    );
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
