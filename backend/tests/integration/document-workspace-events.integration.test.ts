import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  buildWorkspaceEventDelivery,
  buildWorkspaceEventLog,
  documentEventEraser,
  workspaceEventRecorder,
} from "../../src/app/composition/workspaceEventLog.js";
import { AccountMembershipRepository } from "../../src/db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { BackgroundJobRepository } from "../../src/db/repositories/backgroundJobRepository.js";
import {
  DocumentProcessingJobRepository,
  type DocumentProcessingJobRecord,
} from "../../src/db/repositories/documentProcessingJobRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { DocumentSourceRepository } from "../../src/db/repositories/documentSourceRepository.js";
import { MachineAccessRepository } from "../../src/db/repositories/machineAccessRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AccountAccessService } from "../../src/modules/account/public.js";
import { ChunkRepository } from "../../src/modules/documents/infra/chunkRepository.js";
import { DocumentImportService } from "../../src/modules/documents/services/documentImportService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker, type DocumentImageCaptureStage } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { DocumentSourceContentService } from "../../src/modules/documents/services/documentSourceContentService.js";
import { documentFailedEvent, documentProcessedEvent } from "../../src/modules/documents/services/documentWorkspaceEvents.js";
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
import { createAuditService, InMemoryDocumentStorage } from "../support/fakes.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const EMBEDDING_DIMENSIONS = 1536;
// Matches MAX_ATTEMPTS and the lease the worker is built with below.
const MAX_ATTEMPTS = 3;
const JOB_LEASE_MS = 300_000;
const afterLease = (claimedAt: Date) => new Date(claimedAt.getTime() + JOB_LEASE_MS + 1);
// A run's clock a minute ahead: a job's available_at is the database's now(), to the microsecond.
const aMinuteAhead = () => new Date(Date.now() + 60_000);
const MISCONFIGURED_KEY_MESSAGE = "The embedding key sk-example-0000 was rejected for this workspace";

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
  const documents = new DocumentRepository(db, documentEventEraser);
  const jobs = new DocumentProcessingJobRepository(db, workspaceEventRecorder);
  const sources = new DocumentSourceRepository(db);
  const ingestion = new DocumentIngestionService(documents, auditService);
  const log = buildWorkspaceEventLog(db, null);
  const embeddingSpaceId = randomUUID();
  const seededAccountIds: string[] = [];
  let receiver: Awaited<ReturnType<typeof startReceiver>>;

  const unitVector = async () => {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    vector[0] = 1;
    return vector;
  };
  /** The real processing pipeline, embedding through `embed` and reading stored files through `content`. */
  const processingWith = (embed: () => Promise<number[]>, content?: DocumentSourceContentService) => new DocumentProcessingService(
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
    content,
  );
  const processing = processingWith(unitVector);
  const failing = processingWith(async () => { throw new ProviderConfigurationError(MISCONFIGURED_KEY_MESSAGE); });

  const buildWorker = (input: {
    processingService?: unknown;
    wake?: WorkspaceEventDeliveryWake;
    embeddingProfileJobs?: unknown;
    imageCapture?: DocumentImageCaptureStage;
  } = {}) =>
    new DocumentProcessingWorker(
      documents,
      jobs,
      (input.processingService ?? processing) as DocumentProcessingService,
      auditService,
      logger,
      10_000,
      undefined,
      JOB_LEASE_MS,
      undefined,
      undefined,
      input.embeddingProfileJobs as never,
      undefined,
      undefined,
      undefined,
      undefined,
      input.imageCapture,
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

  /** A text document an operator adds on its own, and its queued vectorize job. */
  const addText = async (workspaceId: string, title: string) => {
    const { documentId } = await ingestion.ingest({ workspaceId, title, content: `${title}\n\nOpening hours are nine to five on weekdays, and the front desk answers the phone until six.` });
    const job = await jobs.findByDocumentRevision({ documentId, workspaceId, documentRevision: 1 });
    if (!job) throw new Error("Expected the added document to queue a vectorize job");
    return { documentId, job };
  };

  /** A website source with one crawled page in it. */
  const addCrawledPage = async (workspaceId: string, title: string) => {
    const sourceId = randomUUID();
    await database.query("INSERT INTO document_sources (id, workspace_id, kind, name) VALUES ($1, $2, 'website', 'Example site')", [sourceId, workspaceId]);
    const page = await addText(workspaceId, title);
    await database.query("UPDATE documents SET source_id = $1, external_document_id = $2 WHERE id = $3", [sourceId, `https://site.example/${page.documentId}`, page.documentId]);
    return { ...page, sourceId };
  };

  /** Waits until every transaction that had begun has finished, so the log's horizon is past this file's writes. */
  const settle = async (): Promise<void> => {
    const [{ xmax }] = await database.query<{ xmax: string }>("SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS xmax");
    await vi.waitFor(async () => {
      const [{ passed }] = await database.query<{ passed: boolean }>("SELECT pg_snapshot_xmin(pg_current_snapshot()) >= $1::xid8 AS passed", [xmax]);
      expect(passed).toBe(true);
    }, { timeout: 10_000, interval: 25 });
  };

  /** Every event an automation reading the whole log sees, oldest first, each parsed against its type's published schema. */
  const eventsOf = async (workspaceId: string): Promise<WorkspaceEvent[]> => {
    await settle();
    const page = await log.list({ workspaceId, readableTypes: [...WORKSPACE_EVENT_TYPES], requestedTypes: null, after: null, limit: 100 });
    for (const event of page.events) {
      expect(event.version).toBe(WORKSPACE_EVENT_VERSIONS[event.type]);
      workspaceEventDataSchema(event.type).strict().parse(event.data);
    }
    return page.events;
  };

  /** A job that has used all but its last attempt, so the next failure is its last. */
  const onLastAttempt = (job: DocumentProcessingJobRecord) =>
    database.query("UPDATE document_processing_jobs SET attempt_count = $1 WHERE id = $2", [MAX_ATTEMPTS - 1, job.id]);

  it("records one document.processed when a document finishes processing, naming its revision and its source", async () => {
    const seeded = await seedWorkspace();
    const typed = await addText(seeded.workspaceId, "Opening hours");
    const crawled = await addCrawledPage(seeded.workspaceId, "Contact page");
    const worker = buildWorker();

    expect(await worker.runJobById(typed.job.id, aMinuteAhead())).toBe("processed");
    expect(await worker.runJobById(crawled.job.id, aMinuteAhead())).toBe("processed");

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => [event.type, event.data.documentId])).toEqual([
      ["document.processed", typed.documentId],
      ["document.processed", crawled.documentId],
    ]);
    expect(events[0]).toMatchObject({
      workspaceId: seeded.workspaceId,
      data: { documentId: typed.documentId, revision: 1, title: "Opening hours", contentKind: "inline_text", sourceKind: null, sourceId: null },
    });
    expect(events[1].data).toEqual({
      documentId: crawled.documentId,
      revision: 1,
      title: "Contact page",
      contentKind: "inline_text",
      sourceKind: "website",
      sourceId: crawled.sourceId,
    });
  });

  it("names the workspace's uploads source for a file uploaded through the import path", async () => {
    const seeded = await seedWorkspace();
    const storage = new InMemoryDocumentStorage();
    const imports = new DocumentImportService(documents, auditService, storage, undefined, jobs, undefined, undefined, sources);
    const { documentId } = await imports.importDocument({
      workspaceId: seeded.workspaceId,
      filename: "returns-policy.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Returns policy\n\nItems can be returned within thirty days with the receipt."),
    });
    const job = await jobs.findByDocumentRevision({ documentId, workspaceId: seeded.workspaceId, documentRevision: 1 });
    const uploaded = await documents.findByIdAndWorkspaceId(documentId, seeded.workspaceId);

    const worker = buildWorker({ processingService: processingWith(unitVector, new DocumentSourceContentService(storage)) });
    expect(await worker.runJobById(job!.id, aMinuteAhead())).toBe("processed");

    const [event] = await eventsOf(seeded.workspaceId);
    expect(event.data).toEqual({
      documentId,
      revision: 1,
      title: uploaded!.title,
      contentKind: "uploaded_file",
      sourceKind: "upload",
      sourceId: uploaded!.sourceId,
    });
    expect(uploaded!.sourceId).not.toBeNull();
  });

  it("records it once when a run is cut off after publishing and a restarted worker completes the job", async () => {
    const seeded = await seedWorkspace();
    const { job } = await addText(seeded.workspaceId, "Parking");
    // The first run claims the job and publishes the document, then its process dies before the
    // job's own completion is written.
    const claimed = await jobs.claimById(job.id, aMinuteAhead());
    expect(await processing.process(claimed!)).toBe("completed");

    const restarted = buildWorker();
    await restarted.start();
    await restarted.stop();
    // The first run's completion arrives late, and a redelivered task asks for the job again.
    expect(await jobs.markCompleted(claimed!, documentProcessedEvent(claimed!))).toBe(false);
    expect(await restarted.runJobById(job.id, aMinuteAhead())).toBe("noop");

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => [event.type, event.data.documentId])).toEqual([["document.processed", job.documentId]]);
    expect((await jobs.findById(job.id))?.status).toBe("completed");
  });

  it("records it once when a run that lost its lease finishes after the run that took the job over", async () => {
    const seeded = await seedWorkspace();
    const { job } = await addText(seeded.workspaceId, "Deliveries");
    const firstClaim = aMinuteAhead();
    const first = await jobs.claimById(job.id, firstClaim);
    expect(first?.attemptCount).toBe(1);

    // The lease runs out: a redelivered task releases the job and runs it again to completion.
    expect(await buildWorker().runJobById(job.id, afterLease(firstClaim))).toBe("processed");
    expect(await jobs.findById(job.id)).toMatchObject({ status: "completed", attemptCount: 2 });
    // The first run finally finishes.
    expect(await jobs.markCompleted(first!, documentProcessedEvent(first!))).toBe(false);

    const events = await eventsOf(seeded.workspaceId);
    expect(events.filter((event) => event.type === "document.processed")).toHaveLength(1);
  });

  it("keeps a run that lost its lease from failing the document the run that took it over completes", async () => {
    const seeded = await seedWorkspace();
    const { documentId, job } = await addText(seeded.workspaceId, "Gift wrapping");
    const firstClaim = aMinuteAhead();
    const first = await jobs.claimById(job.id, firstClaim);
    expect(await jobs.releaseOrFailExpiredClaim({
      jobId: job.id,
      claimedAtOrBefore: afterLease(firstClaim),
      maxAttempts: MAX_ATTEMPTS,
      releasedReason: "claim_expired",
      exhaustedReason: "claim_expired_attempts_exhausted",
    })).toEqual({ outcome: "released" });
    const second = await jobs.claimById(job.id, afterLease(firstClaim));
    expect(second?.attemptCount).toBe(2);

    // The first run gives up and fails its job while the second is still working on it.
    expect(await jobs.markFailedIfDocumentMatches({
      claim: first!,
      documentId,
      workspaceId: seeded.workspaceId,
      revision: 1,
      errorMessage: MISCONFIGURED_KEY_MESSAGE,
      errorCode: "provider_misconfigured",
      event: documentFailedEvent(first!, "provider_misconfigured"),
    })).toBe(false);
    expect((await documents.findByIdAndWorkspaceId(documentId, seeded.workspaceId))?.status).not.toBe("failed");

    expect(await processing.process(second!)).toBe("completed");
    expect(await jobs.markCompleted(second!, documentProcessedEvent(second!))).toBe(true);

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => event.type)).toEqual(["document.processed"]);
    expect((await documents.findByIdAndWorkspaceId(documentId, seeded.workspaceId))?.status).toBe("ready");
  });

  it("records one document.processed when a run past its last attempt had already published the document", async () => {
    const seeded = await seedWorkspace();
    const { job } = await addText(seeded.workspaceId, "Returns");
    await onLastAttempt(job);
    const claimedAt = aMinuteAhead();
    const claimed = await jobs.claimById(job.id, claimedAt);
    expect(claimed?.attemptCount).toBe(MAX_ATTEMPTS);
    expect(await processing.process(claimed!)).toBe("completed");

    // The lease expires with no attempts left; recovery finds the document already published.
    expect(await buildWorker().runJobById(job.id, afterLease(claimedAt))).toBe("noop");

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => event.type)).toEqual(["document.processed"]);
    expect((await jobs.findById(job.id))?.status).toBe("completed");
  });

  it("records nothing for a revision the document moved past before its processing completed", async () => {
    const seeded = await seedWorkspace();
    const { documentId, job } = await addText(seeded.workspaceId, "Seasonal menu");
    // A reprocess is queued while the first revision is finishing.
    const overtaken = {
      process: async (claimed: DocumentProcessingJobRecord) => {
        const outcome = await processing.process(claimed);
        await documents.requeue(documentId, seeded.workspaceId);
        return outcome;
      },
    };

    expect(await buildWorker({ processingService: overtaken }).runJobById(job.id, aMinuteAhead())).toBe("processed");

    expect((await jobs.findById(job.id))?.status).toBe("completed");
    expect(await eventsOf(seeded.workspaceId)).toEqual([]);
  });

  it("records nothing for enrichment, image capture and embedding-profile completions", async () => {
    const seeded = await seedWorkspace();
    const { documentId, job } = await addText(seeded.workspaceId, "Loyalty card");
    const worker = buildWorker({
      processingService: { process: (claimed: DocumentProcessingJobRecord) => processing.process(claimed), processEnrichment: async () => "completed" },
      embeddingProfileJobs: { process: async () => "completed" },
      imageCapture: { capture: async () => "completed", afterRevisionPublished: async () => undefined, sweepReleased: async () => undefined },
    });
    expect(await worker.runJobById(job.id, aMinuteAhead())).toBe("processed");
    const revision = { documentId, workspaceId: seeded.workspaceId, documentRevision: 1 };
    const enrich = await jobs.ensureFollowUpJob({ kind: "enrich", ...revision });
    const images = await jobs.ensureFollowUpJob({ kind: "images", ...revision });
    const [profile] = await database.query<{ id: string }>(
      `INSERT INTO document_processing_jobs (id, document_id, workspace_id, document_revision, status, kind, embedding_space_id, workspace_profile_generation)
       VALUES ($1, $2, $3, 1, 'queued', 'embedding_profile', $4, 1) RETURNING id`,
      [randomUUID(), documentId, seeded.workspaceId, embeddingSpaceId],
    );

    for (const followUp of [enrich.id, images.id, profile.id]) {
      expect(await worker.runJobById(followUp, aMinuteAhead())).toBe("processed");
      expect((await jobs.findById(followUp))?.status).toBe("completed");
    }

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => event.type)).toEqual(["document.processed"]);
  });

  it("records document.failed with the failure's code and never its message when processing fails", async () => {
    const seeded = await seedWorkspace();
    const { documentId, job } = await addText(seeded.workspaceId, "Price list");
    await onLastAttempt(job);

    expect(await buildWorker({ processingService: failing }).runJobById(job.id, aMinuteAhead())).toBe("processed");

    expect((await documents.findByIdAndWorkspaceId(documentId, seeded.workspaceId))?.status).toBe("failed");
    const events = await eventsOf(seeded.workspaceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "document.failed",
      data: { documentId, revision: 1, title: "Price list", contentKind: "inline_text", sourceKind: null, sourceId: null, failureCode: "provider_misconfigured" },
    });
    expect(JSON.stringify(events[0])).not.toContain("sk-example-0000");
    expect(JSON.stringify(events[0])).not.toContain("rejected");
  });

  it("records document.processed for the same revision once a credential fix queues a failed document again", async () => {
    const seeded = await seedWorkspace();
    const { documentId, job } = await addText(seeded.workspaceId, "Store locations");
    await onLastAttempt(job);
    expect(await buildWorker({ processingService: failing }).runJobById(job.id, aMinuteAhead())).toBe("processed");

    expect(await jobs.requeueProviderCredentialFailures(seeded.workspaceId)).toBe(1);
    expect(await buildWorker().runJobById(job.id, aMinuteAhead())).toBe("processed");

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => [event.type, event.data.documentId, event.data.revision])).toEqual([
      ["document.failed", documentId, 1],
      ["document.processed", documentId, 1],
    ]);
  });

  it("records a second document.failed when a revision queued again after a credential fix fails again", async () => {
    const seeded = await seedWorkspace();
    const { job } = await addText(seeded.workspaceId, "Warranty terms");
    await onLastAttempt(job);
    const worker = buildWorker({ processingService: failing });
    expect(await worker.runJobById(job.id, aMinuteAhead())).toBe("processed");

    expect(await jobs.requeueProviderCredentialFailures(seeded.workspaceId)).toBe(1);
    expect(await worker.runJobById(job.id, aMinuteAhead())).toBe("processed");

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => [event.type, event.data.revision, event.data.failureCode])).toEqual([
      ["document.failed", 1, "provider_misconfigured"],
      ["document.failed", 1, "provider_misconfigured"],
    ]);
  });

  it("removes a document's events with the document, whichever way it is deleted", async () => {
    const seeded = await seedWorkspace();
    const kept = await addText(seeded.workspaceId, "Opening hours");
    const deletedAlone = await addText(seeded.workspaceId, "Ada Example CV");
    const deletedWithSource = await addCrawledPage(seeded.workspaceId, "Team page");
    const prunedFromSource = await addCrawledPage(seeded.workspaceId, "Old offers");
    const worker = buildWorker();
    for (const page of [kept, deletedAlone, deletedWithSource, prunedFromSource]) {
      expect(await worker.runJobById(page.job.id, aMinuteAhead())).toBe("processed");
    }
    expect(await eventsOf(seeded.workspaceId)).toHaveLength(4);

    expect(await documents.deleteByIdAndWorkspaceId(deletedAlone.documentId, seeded.workspaceId)).toBe(true);
    expect((await documents.deleteBySourceIdAndWorkspaceId(deletedWithSource.sourceId, seeded.workspaceId)).count).toBe(1);
    expect((await documents.deleteMissingSourcePages({
      workspaceId: seeded.workspaceId,
      sourceId: prunedFromSource.sourceId,
      documentIds: [prunedFromSource.documentId],
    })).deletedCount).toBe(1);

    const events = await eventsOf(seeded.workspaceId);
    expect(events.map((event) => event.data.documentId)).toEqual([kept.documentId]);
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
    const { documentId, job } = await addText(seeded.workspaceId, "Gift cards");
    // The wake the deployment builds, run once the log's horizon has passed the completion, as it
    // does when no older write transaction is still open.
    const woken: string[] = [];
    const worker = buildWorker({ wake: { requestDelivery: (workspaceId) => { woken.push(workspaceId); void settle().then(() => delivery.wake.requestDelivery(workspaceId)); } } });

    expect(await worker.runJobById(job.id, aMinuteAhead())).toBe("processed");

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
