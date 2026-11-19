import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildWorkspaceEventDelivery,
  buildWorkspaceEventDeliveryWake,
  withWorkspaceEvents,
  workspaceEventRecorder,
} from "../../src/app/composition/workspaceEventLog.js";
import { AccountMembershipRepository } from "../../src/db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { BackgroundJobRepository } from "../../src/db/repositories/backgroundJobRepository.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { MachineAccessRepository } from "../../src/db/repositories/machineAccessRepository.js";
import { WorkspaceEventSubscriptionRepository } from "../../src/db/repositories/workspaceEventSubscriptionRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AccountAccessService } from "../../src/modules/account/public.js";
import { PostgresAssistantTurnPersistence } from "../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { ApiPrincipalAuthenticator } from "../../src/modules/machineAccess/public.js";
import { WorkspaceEventDeliveryScheduler } from "../../src/modules/workspaceEventLog/public.js";
import {
  BackgroundJobRuntime,
  DefaultBackgroundJobQueue,
  NoopBackgroundJobWake,
} from "../../src/shared/background-jobs/index.js";
import {
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_EVENT_VERSIONS,
  workspaceEventDataSchema,
  type WorkspaceEventType,
} from "../../src/shared/domain/workspaceEventLog.js";
import { verifyWebhookSignature } from "../../src/shared/infra/http/signedWebhook.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/** The envelope every push carries, as `GET /api/v1/workspace/events` publishes it. */
const pushedEnvelope = z.object({
  id: z.string().uuid(),
  type: z.enum(WORKSPACE_EVENT_TYPES),
  version: z.number().int(),
  occurredAt: z.string().datetime(),
  workspaceId: z.string().uuid(),
  data: z.record(z.string(), z.unknown()),
}).strict();

interface ReceivedPush {
  headers: IncomingHttpHeaders;
  rawBody: string;
}

/** A receiver on this machine that answers each push with the next scripted status, then 200. */
const startReceiver = async () => {
  const received: ReceivedPush[] = [];
  const statuses: number[] = [];
  const server: Server = createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { rawBody += chunk; });
    request.on("end", () => {
      received.push({ headers: request.headers, rawBody });
      response.statusCode = statuses.shift() ?? 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks/radioso`,
    received,
    answerWith: (...next: number[]) => { statuses.push(...next); },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describeIntegration("workspace event subscriptions (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const db = database.kysely;
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const audited: Array<{ eventType: string; metadata?: Record<string, unknown> }> = [];
  const audit = { record: vi.fn(async (event: { eventType: string; metadata?: Record<string, unknown> }) => { audited.push(event); }) };
  const machineAccess = new MachineAccessRepository(db);
  const accountAccessService = new AccountAccessService(new AccountMembershipRepository(db), audit as never);
  const access = {
    apiPrincipalAuthenticator: new ApiPrincipalAuthenticator({ repository: machineAccess, accountAccess: accountAccessService }),
    accountAccessService,
  };
  const jobs = new BackgroundJobRepository(db);
  const queue = new DefaultBackgroundJobQueue({ writer: jobs, wake: new NoopBackgroundJobWake(), logger });
  const env = {
    CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
    CONNECTOR_ENCRYPTION_PREVIOUS_KEYS: undefined,
    NODE_ENV: "test" as const,
    WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: true,
  };
  const infrastructure = { database: { kysely: db }, auditService: audit, metricsRegistry: null };
  const workspaces = new WorkspaceRepository(db);
  // The real outbound URL guard, and plain http to this machine for the test receiver.
  const delivery = buildWorkspaceEventDelivery({ infrastructure, env, queue, access, workspaces, logger });
  // Delivery as a production deployment runs it: no loopback, so only public addresses are posted to.
  const productionDelivery = buildWorkspaceEventDelivery({ infrastructure, env: { ...env, WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: false }, queue, access, workspaces, logger });
  // Creates without asking DNS, for a target the deployment's guard is later asked about.
  const unguardedCreates = buildWorkspaceEventDelivery({ infrastructure, env, queue, access, workspaces, logger, assertPublicUrl: async () => undefined });
  const runtimeFor = (handler: typeof delivery.jobHandler) =>
    new BackgroundJobRuntime({ store: jobs, handlers: [handler], wake: new NoopBackgroundJobWake(), logger });
  const runtime = runtimeFor(delivery.jobHandler);
  const wakeScheduler = new WorkspaceEventDeliveryScheduler({ subscriptions: new WorkspaceEventSubscriptionRepository(db), queue, logger });
  const conversations = new ConversationRepository(db, workspaceEventRecorder);
  const persistence = new PostgresAssistantTurnPersistence(
    db,
    withWorkspaceEvents(new ConversationActivityRepository(db)),
    workspaceEventRecorder,
    60_000,
    undefined,
    undefined,
    logger,
    queue,
    undefined,
    undefined,
    undefined,
    buildWorkspaceEventDeliveryWake({ db, queue, logger }),
  );
  const seededAccountIds: string[] = [];
  let receiver: Awaited<ReturnType<typeof startReceiver>>;

  beforeAll(async () => {
    receiver = await startReceiver();
  });

  afterAll(async () => {
    await receiver.close();
    if (seededAccountIds.length > 0) {
      await database.query("DELETE FROM background_jobs WHERE kind = 'workspace_events.deliver' AND payload->>'workspaceId' IN (SELECT id::text FROM workspaces WHERE account_id = ANY($1::uuid[]))", [seededAccountIds]);
      await database.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [seededAccountIds]);
    }
    await database.close().catch(() => undefined);
  });

  /** A workspace, an agent, and the service account credential a Zapier connection would use. */
  const seedWorkspace = async () => {
    const account = await new AccountRepository(db).create({ name: "Subscriptions", email: `subscriptions-${randomUUID()}@example.com`, passwordHash: "hash" });
    seededAccountIds.push(account.id);
    const workspace = await workspaces.create(account.id, "Subscriptions Workspace");
    const agentId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Front desk')", [agentId, workspace.id]);
    const userId = randomUUID();
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [userId, `owner-${userId}@example.com`]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')", [randomUUID(), account.id, userId]);
    const service = await machineAccess.createServiceAccountWithinLimit({
      workspaceId: workspace.id,
      accountId: account.id,
      displayName: "Zapier connection",
      role: "member",
      createdByUserId: userId,
      credentialLabel: "zapier",
      expiresAt: new Date(Date.now() + 86_400_000),
      limit: 50,
      issueSecret: () => ({ secret: "unused", tokenPrefix: "radioso_svc_v1_test", tokenHash: `hash-${randomUUID()}` }),
    });
    if (!service) throw new Error("Expected a service account");
    const createdBy = { kind: "service_account" as const, credentialId: service.credential.id, serviceAccountId: service.account.id };
    return { accountId: account.id, workspaceId: workspace.id, agentId, userId, createdBy, credentialId: service.credential.id };
  };

  type Seeded = Awaited<ReturnType<typeof seedWorkspace>>;

  const subscribe = (
    seeded: Seeded,
    options: { targetUrl?: string; eventTypes?: WorkspaceEventType[]; via?: typeof delivery } = {},
  ) => (options.via ?? delivery).subscriptions.create({
    workspaceId: seeded.workspaceId,
    actor: { accountId: seeded.accountId },
    createdBy: seeded.createdBy,
    targetUrl: options.targetUrl ?? receiver.url,
    eventTypes: options.eventTypes ?? ["handoff.requested", "conversation.started"],
    label: "zapier",
    readableTypes: [...WORKSPACE_EVENT_TYPES],
  });

  /** Waits until every transaction that had begun has finished, so the log's horizon is past this file's writes. */
  const settle = async (): Promise<void> => {
    const [{ xmax }] = await database.query<{ xmax: string }>("SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS xmax");
    await vi.waitFor(async () => {
      const [{ passed }] = await database.query<{ passed: boolean }>("SELECT pg_snapshot_xmin(pg_current_snapshot()) >= $1::xid8 AS passed", [xmax]);
      expect(passed).toBe(true);
    }, { timeout: 10_000, interval: 25 });
  };

  const recordHandoff = async (seeded: Seeded, conversationId: string) => {
    await workspaceEventRecorder.record(db, { type: "handoff.requested", workspaceId: seeded.workspaceId, conversationId, detail: { reason: "routine_handoff" } });
  };

  /** Runs the subscription's drain the way the worker does: the sweep enqueues it, the runtime runs it. */
  const deliverNow = async (run = runtime) => {
    await settle();
    await delivery.periodicTask.handle.run();
    await run.drain({ maxJobs: 50 });
  };

  const pushesFor = (seeded: Seeded) => receiver.received.filter((push) => JSON.parse(push.rawBody).workspaceId === seeded.workspaceId);

  const subscriptionRow = async (subscriptionId: string) => {
    const [row] = await database.query<{
      status: string;
      disabled_reason: string | null;
      consecutive_failures: number;
      next_attempt_at: Date | null;
      failing_since: Date | null;
      last_delivery_outcome: string | null;
      last_delivery_status_code: number | null;
    }>("SELECT status, disabled_reason, consecutive_failures, next_attempt_at, failing_since, last_delivery_outcome, last_delivery_status_code FROM workspace_event_subscriptions WHERE id = $1", [subscriptionId]);
    return row ?? null;
  };

  /** Makes a subscription in backoff due now, as the clock passing its next attempt would. */
  const makeDue = (subscriptionId: string) =>
    database.query("UPDATE workspace_event_subscriptions SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [subscriptionId]);

  it("delivers a turn's event to its subscription, signed so the receiver can verify it, after the turn's own wake", async () => {
    const seeded = await seedWorkspace();
    const { subscription, signingSecret } = await subscribe(seeded, { eventTypes: ["handoff.requested"] });
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    await settle();

    const receipt = await persistence.completeAssistantTurn({
      workspaceId: seeded.workspaceId,
      conversationId: conversation.id,
      assistantMessage: { id: randomUUID(), conversationId: conversation.id, workspaceId: seeded.workspaceId, role: "assistant", content: "A teammate will take it from here." },
      auditEvent: { eventType: "chat.answer", eventStatus: "success", workspaceId: seeded.workspaceId, metadata: {} },
      ownershipHandoff: { reason: "routine_handoff" },
    });
    await settle();
    receipt.afterCommit?.();
    // The wake, not the sweep, queues the drain.
    await vi.waitFor(async () => {
      const [{ count }] = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM background_jobs WHERE kind = 'workspace_events.deliver' AND idempotency_key = $1", [subscription.id]);
      expect(count).toBe("1");
    }, { timeout: 5_000 });
    await runtime.drain({ maxJobs: 50 });

    const [push] = pushesFor(seeded);
    expect(push).toBeDefined();
    const timestamp = String(push.headers["x-radioso-timestamp"]);
    expect(verifyWebhookSignature({ rawBody: push.rawBody, secret: signingSecret, timestamp, signatureHeader: String(push.headers["x-radioso-signature"]) })).toBe(true);
    expect(verifyWebhookSignature({ rawBody: push.rawBody, secret: "another secret", timestamp, signatureHeader: String(push.headers["x-radioso-signature"]) })).toBe(false);
    const event = pushedEnvelope.parse(JSON.parse(push.rawBody));
    expect(event).toMatchObject({ type: "handoff.requested", version: WORKSPACE_EVENT_VERSIONS["handoff.requested"], workspaceId: seeded.workspaceId });
    expect(workspaceEventDataSchema(event.type).strict().parse(event.data)).toMatchObject({ conversationId: conversation.id, reason: "routine_handoff" });
    expect(push.headers["idempotency-key"]).toBe(event.id);
    expect(push.headers["content-type"]).toBe("application/json");

    const [listed] = await delivery.subscriptions.list(seeded.workspaceId);
    expect(listed).toMatchObject({
      id: subscription.id,
      targetHost: new URL(receiver.url).host,
      status: "active",
      createdBy: { kind: "service_account", label: "Zapier connection" },
      lastDelivery: { outcome: "delivered", statusCode: 200 },
    });
    expect(JSON.stringify(listed)).not.toContain("/hooks/radioso");
  });

  it("holds newer events behind a failing one and delivers them in order once the target recovers, backing off between tries", async () => {
    const seeded = await seedWorkspace();
    const { subscription } = await subscribe(seeded, { eventTypes: ["handoff.requested"] });
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    for (let index = 0; index < 3; index += 1) await recordHandoff(seeded, conversation.id);

    receiver.answerWith(503);
    await deliverNow();
    expect(pushesFor(seeded)).toHaveLength(1);
    const first = await subscriptionRow(subscription.id);
    expect(first).toMatchObject({ status: "active", consecutive_failures: 1, last_delivery_outcome: "failed", last_delivery_status_code: 503 });
    const firstWait = first.next_attempt_at!.getTime() - first.failing_since!.getTime();
    expect(firstWait).toBeGreaterThanOrEqual(29_000);
    expect(firstWait).toBeLessThanOrEqual(31_000);

    // Not due yet: neither the sweep nor a wake sends the failing event again.
    await deliverNow();
    await expect(wakeScheduler.deliverWorkspace(seeded.workspaceId)).resolves.toBe(0);
    await runtime.drain({ maxJobs: 50 });
    expect(pushesFor(seeded)).toHaveLength(1);

    receiver.answerWith(500);
    await makeDue(subscription.id);
    await deliverNow();
    const second = await subscriptionRow(subscription.id);
    expect(second.consecutive_failures).toBe(2);
    expect(second.next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(55_000);

    await makeDue(subscription.id);
    await deliverNow();
    const pushes = pushesFor(seeded).map((push) => JSON.parse(push.rawBody) as { id: string; occurredAt: string });
    expect(pushes).toHaveLength(5);
    // The failing event went three times, then the two behind it, in log order.
    expect(pushes[0].id).toBe(pushes[1].id);
    expect(pushes[1].id).toBe(pushes[2].id);
    expect(new Set(pushes.slice(2).map((push) => push.id)).size).toBe(3);
    const log = await database.query<{ id: string }>(
      "SELECT id FROM workspace_events WHERE workspace_id = $1 AND type = 'handoff.requested' ORDER BY tx_id, position",
      [seeded.workspaceId],
    );
    expect(pushes.slice(2).map((push) => push.id)).toEqual(log.map((row) => row.id));
    expect(await subscriptionRow(subscription.id)).toMatchObject({ consecutive_failures: 0, next_attempt_at: null, failing_since: null, last_delivery_outcome: "delivered" });
  });

  it("deletes a subscription whose target answers 410 Gone, and audits it", async () => {
    const seeded = await seedWorkspace();
    const { subscription } = await subscribe(seeded);
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    await recordHandoff(seeded, conversation.id);

    receiver.answerWith(410);
    await deliverNow();

    expect(await subscriptionRow(subscription.id)).toBeNull();
    expect(await delivery.subscriptions.list(seeded.workspaceId)).toEqual([]);
    expect(audited).toContainEqual(expect.objectContaining({
      eventType: "workspace_event_subscription.removed",
      metadata: expect.objectContaining({ subscriptionId: subscription.id, reason: "target_gone" }),
    }));
    // The second event is never sent: the subscription is gone.
    expect(pushesFor(seeded)).toHaveLength(1);
  });

  it("disables a subscription whose target has failed for a day, after at least five attempts", async () => {
    const seeded = await seedWorkspace();
    const { subscription } = await subscribe(seeded, { eventTypes: ["handoff.requested"] });
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    await recordHandoff(seeded, conversation.id);
    await database.query(
      "UPDATE workspace_event_subscriptions SET consecutive_failures = 4, failing_since = now() - interval '25 hours', last_delivery_outcome = 'failed', last_delivery_at = now() WHERE id = $1",
      [subscription.id],
    );

    receiver.answerWith(502);
    await deliverNow();

    expect(await subscriptionRow(subscription.id)).toMatchObject({ status: "disabled", disabled_reason: "delivery_failing", consecutive_failures: 5 });
    const [listed] = await delivery.subscriptions.list(seeded.workspaceId);
    expect(listed).toMatchObject({ status: "disabled", disabledReason: "delivery_failing" });
    expect(audited).toContainEqual(expect.objectContaining({
      eventType: "workspace_event_subscription.disabled",
      metadata: expect.objectContaining({ subscriptionId: subscription.id, reason: "delivery_failing" }),
    }));

    // A disabled subscription is never drained again.
    receiver.answerWith(200);
    await makeDue(subscription.id);
    await deliverNow();
    expect(pushesFor(seeded)).toHaveLength(1);
  });

  it("disables a subscription once the token that created it is revoked, without sending", async () => {
    const seeded = await seedWorkspace();
    const { subscription } = await subscribe(seeded, { eventTypes: ["handoff.requested"] });
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    await recordHandoff(seeded, conversation.id);
    await machineAccess.revokeCredential({ id: seeded.credentialId, actorUserId: seeded.userId, now: new Date() });

    await deliverNow();

    expect(pushesFor(seeded)).toHaveLength(0);
    expect(await subscriptionRow(subscription.id)).toMatchObject({ status: "disabled", disabled_reason: "creator_revoked" });
    expect(audited).toContainEqual(expect.objectContaining({
      eventType: "workspace_event_subscription.disabled",
      metadata: expect.objectContaining({ subscriptionId: subscription.id, reason: "creator_revoked" }),
    }));
  });

  it("refuses a private target at create, and at delivery when the stored target no longer passes the guard", async () => {
    const seeded = await seedWorkspace();
    for (const targetUrl of ["https://10.0.0.5/hook", "https://127.0.0.1/hook", "http://hooks.example/hook", "not a url"]) {
      await expect(subscribe(seeded, { targetUrl, via: productionDelivery })).rejects.toMatchObject({ statusCode: 400, code: "invalid_target_url" });
    }
    expect(await delivery.subscriptions.list(seeded.workspaceId)).toEqual([]);

    const { subscription } = await subscribe(seeded, { targetUrl: "https://10.0.0.5/hook", eventTypes: ["handoff.requested"], via: unguardedCreates });
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    await recordHandoff(seeded, conversation.id);
    await deliverNow(runtimeFor(productionDelivery.jobHandler));

    expect(await subscriptionRow(subscription.id)).toMatchObject({ status: "active", consecutive_failures: 1, last_delivery_outcome: "failed", last_delivery_status_code: null });
  });

  it("holds a workspace to 25 subscriptions, even when creates race", async () => {
    const seeded = await seedWorkspace();
    const attempts = await Promise.allSettled(Array.from({ length: 30 }, () => subscribe(seeded)));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(25);
    for (const refused of attempts.filter((attempt) => attempt.status === "rejected")) {
      expect(refused.reason).toMatchObject({ statusCode: 409, code: "event_subscription_limit_reached" });
    }
    expect(await delivery.subscriptions.list(seeded.workspaceId)).toHaveLength(25);
  });

  it("starts a new subscription at the newest events, and stores its target and secret sealed", async () => {
    const seeded = await seedWorkspace();
    const conversation = await conversations.create({ workspaceId: seeded.workspaceId, agentId: seeded.agentId, sourceChannel: "website_embed" });
    await recordHandoff(seeded, conversation.id);
    await settle();
    const { subscription, signingSecret } = await subscribe(seeded, { eventTypes: ["handoff.requested"] });

    await deliverNow();
    expect(pushesFor(seeded)).toHaveLength(0);

    const [sealed] = await database.query<{ target_url_ciphertext: string; secret_ciphertext: string }>(
      "SELECT target_url_ciphertext, secret_ciphertext FROM workspace_event_subscriptions WHERE id = $1",
      [subscription.id],
    );
    expect(sealed.target_url_ciphertext).not.toContain("127.0.0.1");
    expect(sealed.secret_ciphertext).not.toContain(signingSecret);
  });
});
