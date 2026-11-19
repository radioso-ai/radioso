import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  buildWorkspaceEventDelivery,
  buildWorkspaceEventDeliveryWake,
  buildWorkspaceEventLog,
  workspaceEventRecorder,
} from "../../src/app/composition/workspaceEventLog.js";
import { AccountMembershipRepository } from "../../src/db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { BackgroundJobRepository } from "../../src/db/repositories/backgroundJobRepository.js";
import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { MachineAccessRepository } from "../../src/db/repositories/machineAccessRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AccountAccessService } from "../../src/modules/account/public.js";
import { ChunkRepository } from "../../src/modules/documents/infra/chunkRepository.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { documentProcessedEvent } from "../../src/modules/documents/services/documentWorkspaceEvents.js";
import { ApiPrincipalAuthenticator } from "../../src/modules/machineAccess/public.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import { BackgroundJobRuntime, DefaultBackgroundJobQueue, NoopBackgroundJobWake } from "../../src/shared/background-jobs/index.js";
import {
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_EVENT_VERSIONS,
  workspaceEventDataSchema,
  type WorkspaceEvent,
} from "../../src/shared/domain/workspaceEventLog.js";
import type { WorkspaceEventDeliveryWake } from "../../src/shared/domain/workspaceEventSubscriptions.js";
import { verifyWebhookSignature } from "../../src/shared/infra/http/signedWebhook.js";
import { ProviderConfigurationError } from "../../src/shared/infra/llm/providerTypes.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { createAuditService } from "../support/fakes.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const EMBEDDING_DIMENSIONS = 1536;
// Matches MAX_ATTEMPTS and the lease the worker is built with below.
const MAX_ATTEMPTS = 3;
const JOB_LEASE_MS = 300_000;
const afterLease = (claimedAt: Date) => new Date(claimedAt.getTime() + JOB_LEASE_MS + 1);

/** A receiver on this machine that answers every push 200. */
const startReceiver = async () => {
  const received: Array<{ headers: IncomingHttpHeaders; rawBody: string }> = [];
  const server: Server = createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { rawBody += chunk; });
    request.on("end", () => {
      received.push({ headers: request.headers, rawBody });
      response.statusCode = 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks/radioso`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describeIntegration("document events in the workspace event log (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const db = database.kysely;
  const logger = createLogger("silent");
  const auditService = createAuditService();
  const documents = new DocumentRepository(db);
  const jobs = new DocumentProcessingJobRepository(db, workspaceEventRecorder);
  const ingestion = new DocumentIngestionService(documents, auditService);
  const log = buildWorkspaceEventLog(db, null);
  const embeddingSpaceId = randomUUID();
  const seededAccountIds: string[] = [];
  let receiver: Awaited<ReturnType<typeof startReceiver>>;

  /** The real processing pipeline, embedding through `embed`. */
  const processingWith = (embed: () => Promise<number[]>) => new DocumentProcessingService(
    documents,
    new ChunkRepository(database),
    {
      async embedDocumentChunks(request) {
        return {
          space: { id: embeddingSpaceId, dimensions: EMBEDDING_DIMENSIONS, distanceMetric: "cosine" },
          vectors: await Promise.all(request.texts.map(() => embed())),
        };
      },
    },
    auditService,
    { getForWorkspace: async (workspaceId: string) => defaultIngestionSettings(workspaceId) },
    new ChunkingStrategyRegistry([new FixedWindowChunkingStrategy()]),
  );
  const unitVector = async () => {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    vector[0] = 1;
    return vector;
  };
  const processing = processingWith(unitVector);

  const buildWorker = (input: { processingService?: DocumentProcessingService; wake?: WorkspaceEventDeliveryWake } = {}) =>
    new DocumentProcessingWorker(
      documents,
      jobs,
      input.processingService ?? processing,
      auditService,
      logger,
      10_000,
      undefined,
      JOB_LEASE_MS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      input.wake,
    );

  beforeAll(async () => {
    receiver = await startReceiver();
    await database.query(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization, document_task, query_task, vector_options
       )
       VALUES ($1, $2, 'openai', 'document-events-test-scope', 'text-embedding-3-small', $3, 'cosine',
               'provider_unit', NULL, NULL, '{}'::jsonb)`,
      [embeddingSpaceId, `document-events-${embeddingSpaceId}`, EMBEDDING_DIMENSIONS],
    );
  });

  afterAll(async () => {
    await receiver.close();
    if (seededAccountIds.length > 0) {
      const workspaceIds = "SELECT id FROM workspaces WHERE account_id = ANY($1::uuid[])";
      await database.query(`DELETE FROM background_jobs WHERE kind = 'workspace_events.deliver' AND (payload->>'workspaceId')::uuid IN (${workspaceIds})`, [seededAccountIds]);
      for (const table of ["chunks", "vector_index_work", "vector_index_checkpoints", "document_processing_jobs", "documents"]) {
        await database.query(`DELETE FROM ${table} WHERE workspace_id IN (${workspaceIds})`, [seededAccountIds]).catch(() => undefined);
      }
      await database.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [seededAccountIds]);
    }
    await database.query("DELETE FROM embedding_spaces WHERE id = $1", [embeddingSpaceId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  /** A workspace and its owner, a teammate who may subscribe to its events. */
  const seedWorkspace = async () => {
    const account = await new AccountRepository(db).create({ name: "Document events", email: `document-events-${randomUUID()}@example.com`, passwordHash: "hash" });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(db).create(account.id, "Document Events Workspace");
    const userId = randomUUID();
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [userId, `owner-${userId}@example.com`]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')", [randomUUID(), account.id, userId]);
    return { accountId: account.id, workspaceId: workspace.id, userId };
  };

  const ingest = async (workspaceId: string, title: string) => {
    const { documentId } = await ingestion.ingest({ workspaceId, title, content: `${title}\n\nOpening hours are nine to five on weekdays, and the front desk answers the phone until six.` });
    const job = await jobs.findByDocumentRevision({ documentId, workspaceId, documentRevision: 1 });
    if (!job) throw new Error("Expected the ingested document to queue a vectorize job");
    return { documentId, job };
  };

  /** Waits until every transaction that had begun has finished, so the log's horizon is past this file's writes. */
  const settle = async (): Promise<void> => {
    const [{ xmax }] = await database.query<{ xmax: string }>("SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS xmax");
    await vi.waitFor(async () => {
      const [{ passed }] = await database.query<{ passed: boolean }>("SELECT pg_snapshot_xmin(pg_current_snapshot()) >= $1::xid8 AS passed", [xmax]);
      expect(passed).toBe(true);
    }, { timeout: 10_000, interval: 25 });
  };

  /** Every event an automation reading the whole log sees, each parsed against its type's published schema. */
  const eventsOf = async (workspaceId: string): Promise<WorkspaceEvent[]> => {
    await settle();
    const page = await log.list({ workspaceId, readableTypes: [...WORKSPACE_EVENT_TYPES], requestedTypes: null, after: null, limit: 100 });
    for (const event of page.events) {
      expect(event.version).toBe(WORKSPACE_EVENT_VERSIONS[event.type]);
      workspaceEventDataSchema(event.type).strict().parse(event.data);
    }
    return page.events;
  };

  it("records one document.processed when a document finishes processing, naming its revision and where it came from", async () => {
    const seeded = await seedWorkspace();
    const sourceId = randomUUID();
    await database.query(
      "INSERT INTO document_sources (id, workspace_id, kind, name) VALUES ($1, $2, 'website', 'Example site')",
      [sourceId, seeded.workspaceId],
    );
    const uploaded = await ingest(seeded.workspaceId, "Opening hours");
    const crawled = await ingest(seeded.workspaceId, "Contact page");
    await database.query("UPDATE documents SET source_id = $1 WHERE id = $2", [sourceId, crawled.documentId]);
    const worker = buildWorker();

    while (await worker.runOnce()) { /* drain the queue */ }

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => event.type)).toEqual(["document.processed", "document.processed"]);
    const byDocument = new Map(events.map((event) => [event.data.documentId, event]));
    expect(byDocument.get(uploaded.documentId)).toMatchObject({
      workspaceId: seeded.workspaceId,
      data: { documentId: uploaded.documentId, revision: 1, title: "Opening hours", sourceKind: "inline_text", sourceId: null },
    });
    expect(byDocument.get(crawled.documentId)?.data).toEqual({
      documentId: crawled.documentId,
      revision: 1,
      title: "Contact page",
      sourceKind: "inline_text",
      sourceId,
    });
  });

  it("records it once when a run is cut off after publishing and a restarted worker completes the job", async () => {
    const seeded = await seedWorkspace();
    const { job } = await ingest(seeded.workspaceId, "Parking");
    // The first run claims the job and publishes the document, then its process dies before the
    // job's own completion is written.
    const claimed = await jobs.claimById(job.id);
    expect(await processing.process(claimed!)).toBe("completed");

    const restarted = buildWorker();
    await restarted.start();
    await restarted.stop();
    // The first run's completion arrives late, and a redelivered task asks for the job again.
    expect(await jobs.markCompleted(job.id, documentProcessedEvent(claimed!))).toBe(false);
    expect(await restarted.runJobById(job.id)).toBe("noop");

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => [event.type, event.data.documentId])).toEqual([["document.processed", job.documentId]]);
    expect((await jobs.findById(job.id))?.status).toBe("completed");
  });

  it("records it once when a run that lost its lease finishes after the run that took the job over", async () => {
    const seeded = await seedWorkspace();
    const { job } = await ingest(seeded.workspaceId, "Deliveries");
    const firstClaim = new Date();
    const first = await jobs.claimById(job.id, firstClaim);
    expect(first?.attemptCount).toBe(1);

    // The lease runs out: the worker releases the job and runs it again to completion.
    const worker = buildWorker();
    expect(await worker.runOnce(afterLease(firstClaim))).toBe(true);
    expect((await jobs.findById(job.id))?.status).toBe("completed");
    // The first run finally finishes.
    expect(await jobs.markCompleted(job.id, documentProcessedEvent(first!))).toBe(false);

    const events = await eventsOf(seeded.workspaceId);
    expect(events.filter((event) => event.type === "document.processed")).toHaveLength(1);
  });

  it("records one document.processed when a run past its last attempt had already published the document", async () => {
    const seeded = await seedWorkspace();
    const { job } = await ingest(seeded.workspaceId, "Returns");
    await database.query("UPDATE document_processing_jobs SET attempt_count = $1 WHERE id = $2", [MAX_ATTEMPTS - 1, job.id]);
    const claimedAt = new Date();
    const claimed = await jobs.claimById(job.id, claimedAt);
    expect(claimed?.attemptCount).toBe(MAX_ATTEMPTS);
    expect(await processing.process(claimed!)).toBe("completed");

    // The lease expires with no attempts left; recovery finds the document already published.
    expect(await buildWorker().runOnce(afterLease(claimedAt))).toBe(false);

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => event.type)).toEqual(["document.processed"]);
    expect((await jobs.findById(job.id))?.status).toBe("completed");
  });

  it("records document.failed with the failure's code and never its message when processing fails for good", async () => {
    const seeded = await seedWorkspace();
    const { documentId, job } = await ingest(seeded.workspaceId, "Price list");
    await database.query("UPDATE document_processing_jobs SET attempt_count = $1 WHERE id = $2", [MAX_ATTEMPTS - 1, job.id]);
    const message = "The embedding key sk-example-0000 was rejected for this workspace";
    const failing = processingWith(async () => { throw new ProviderConfigurationError(message); });

    expect(await buildWorker({ processingService: failing }).runOnce()).toBe(true);

    expect((await documents.findByIdAndWorkspaceId(documentId, seeded.workspaceId))?.status).toBe("failed");
    const events = await eventsOf(seeded.workspaceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "document.failed",
      data: { documentId, revision: 1, title: "Price list", sourceKind: "inline_text", sourceId: null, failureCode: "provider_misconfigured" },
    });
    expect(JSON.stringify(events[0])).not.toContain("sk-example-0000");
    expect(JSON.stringify(events[0])).not.toContain("rejected");
  });

  it("pushes a subscribed document.processed, signed, once the worker's completion wakes delivery", async () => {
    const seeded = await seedWorkspace();
    const accountAccessService = new AccountAccessService(new AccountMembershipRepository(db), auditService);
    const backgroundJobs = new BackgroundJobRepository(db);
    const queue = new DefaultBackgroundJobQueue({ writer: backgroundJobs, wake: new NoopBackgroundJobWake(), logger });
    const delivery = buildWorkspaceEventDelivery({
      infrastructure: { database: { kysely: db }, auditService, metricsRegistry: null },
      env: {
        CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
        CONNECTOR_ENCRYPTION_PREVIOUS_KEYS: undefined,
        NODE_ENV: "test",
        WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK: true,
      },
      queue,
      access: {
        apiPrincipalAuthenticator: new ApiPrincipalAuthenticator({ repository: new MachineAccessRepository(db), accountAccess: accountAccessService }),
        accountAccessService,
      },
      workspaces: new WorkspaceRepository(db),
      logger,
    });
    const runtime = new BackgroundJobRuntime({ store: backgroundJobs, handlers: [delivery.jobHandler], wake: new NoopBackgroundJobWake(), logger });
    const { subscription, signingSecret } = await delivery.subscriptions.create({
      workspaceId: seeded.workspaceId,
      actor: { accountId: seeded.accountId },
      createdBy: { kind: "teammate", userId: seeded.userId },
      targetUrl: receiver.url,
      eventTypes: ["document.processed"],
      label: "zapier",
      permits: async () => true,
    });
    const { documentId } = await ingest(seeded.workspaceId, "Gift cards");
    // The wake the worker is built with in production, run once the log's horizon has passed the
    // completion, as it does when no older write transaction is still open.
    const wake = buildWorkspaceEventDeliveryWake({ db, queue, logger })!;
    const woken: string[] = [];
    const worker = buildWorker({ wake: { requestDelivery: (workspaceId) => { woken.push(workspaceId); void settle().then(() => wake.requestDelivery(workspaceId)); } } });

    expect(await worker.runOnce()).toBe(true);

    expect(woken).toEqual([seeded.workspaceId]);
    await vi.waitFor(async () => {
      const [{ count }] = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM background_jobs WHERE kind = 'workspace_events.deliver' AND idempotency_key = $1",
        [subscription.id],
      );
      expect(count).toBe("1");
    }, { timeout: 10_000 });
    await runtime.drain({ maxJobs: 10 });

    const pushes = receiver.received.filter((push) => JSON.parse(push.rawBody).workspaceId === seeded.workspaceId);
    expect(pushes).toHaveLength(1);
    const [push] = pushes;
    expect(verifyWebhookSignature({
      rawBody: push.rawBody,
      secret: signingSecret,
      timestamp: String(push.headers["x-radioso-timestamp"]),
      signatureHeader: String(push.headers["x-radioso-signature"]),
    })).toBe(true);
    const event = JSON.parse(push.rawBody) as WorkspaceEvent;
    expect(event).toMatchObject({ type: "document.processed", version: 1, workspaceId: seeded.workspaceId });
    expect(workspaceEventDataSchema(event.type).strict().parse(event.data)).toMatchObject({ documentId, revision: 1, title: "Gift cards" });
    expect(push.headers["idempotency-key"]).toBe(event.id);
  });
});
