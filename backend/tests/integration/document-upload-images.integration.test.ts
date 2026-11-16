import { randomUUID } from "node:crypto";

import { createNoopWorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createReplyBlocksComposition } from "../../src/app/composition/replyBlocks.js";
import { DocumentProcessingJobRepository, type DocumentProcessingJobRecord } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import {
  ChunkRepository,
  DocumentImageCaptureQueue,
  DocumentImageCaptureService,
  DocumentImageRepository,
  DocumentImportService,
  DocumentProcessingWorker,
  DocumentSourceContentService,
  encodeDocumentImage,
  NoopDocumentJobDispatcher,
  UploadedFileImages,
  type DocumentProcessingService,
} from "../../src/modules/documents/composition.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { buildDocx } from "../support/documentFileFixtures.js";
import { createAuditService, InMemoryDocumentStorage } from "../support/fakes.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SECOND_PASSAGE = "Edelweiss grows on limestone ledges";

const solid = (width: number, height: number, format: "png" | "jpeg") =>
  sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 200 } } })[format]().toBuffer();

describeIntegration("pictures embedded in an uploaded file, from the upload to an answer's offer (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const documents = new DocumentRepository(database.kysely);
  const jobs = new DocumentProcessingJobRepository(database.kysely);
  const images = new DocumentImageRepository(database.kysely);
  const chunks = new ChunkRepository(database);
  const storage = new InMemoryDocumentStorage();
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const logger = createLogger("silent");
  const sourceContent = new DocumentSourceContentService(storage);

  /** Stands in for chunking and embedding: parses the uploaded file as the vectorize job does, then cuts its text at a passage. */
  const processingService = {
    process: vi.fn(async (job: DocumentProcessingJobRecord) => {
      const document = await documents.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
      if (!document) return "deleted";
      const materialized = await sourceContent.materialize(document);
      await documents.updateDerivedContentForRevision({
        documentId: document.id, workspaceId: job.workspaceId, revision: job.documentRevision, ...materialized,
      });
      const text = materialized.markdownContent;
      const cut = text.indexOf(SECOND_PASSAGE);
      await database.query("DELETE FROM chunks WHERE document_id = $1", [document.id]);
      for (const [index, [start, end]] of ([[0, cut], [cut, text.length]] as const).entries()) {
        await database.query(
          `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, start_offset, end_offset)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
          [randomUUID(), document.id, job.workspaceId, index, text.slice(start, end), start, end],
        );
      }
      await documents.setStatusIfRevisionMatches({ documentId: document.id, workspaceId: job.workspaceId, revision: job.documentRevision, status: "ready", failureReason: null });
      return "completed";
    }),
  } as unknown as DocumentProcessingService;

  const dispatcher = new NoopDocumentJobDispatcher();
  const imports = new DocumentImportService(documents, createAuditService(), storage);
  const queue = new DocumentImageCaptureQueue({ images, jobs, dispatcher, documents, logger });
  const capture = new DocumentImageCaptureService({
    images,
    documents,
    chunks,
    storage,
    // An uploaded DOCX names no address: nothing is fetched.
    fetchImage: async () => ({ kind: "failed", reason: "blocked" }),
    encodeImage: encodeDocumentImage,
    uploadedFiles: new UploadedFileImages({ storage, images, logger }),
    logger,
  });
  const worker = new DocumentProcessingWorker(
    documents, jobs, processingService, createAuditService(), logger, 1_000, dispatcher, 300_000,
    undefined, undefined, undefined, undefined, undefined, undefined, createNoopWorkspaceInvalidationPublisher(),
    {
      capture: (job) => capture.capture(job),
      afterRevisionPublished: (job) => queue.afterRevisionPublished(job),
      sweepReleased: () => capture.sweepReleased(),
    },
  );
  let guide: Buffer;

  beforeAll(async () => {
    guide = buildDocx({
      paragraphs: [
        { text: "The guide walks through every meadow above the tree line, season by season, with notes on where each flower grows." },
        { image: { media: "media/image1.png", descr: "Gentians on the ridge above the village" } },
        { text: "Figure 1: Gentians in June", styleId: "Caption" },
        { text: `${SECOND_PASSAGE} and opens late in the summer, long after the gentians.` },
        { image: { media: "media/image2.jpeg", descr: "Edelweiss on a ledge" } },
        { text: "An index of every species closes the guide, with the valley each one is found in." },
      ],
      media: { "media/image1.png": await solid(800, 600, "png"), "media/image2.jpeg": await solid(640, 960, "jpeg") },
      styles: [{ id: "Caption", name: "caption" }],
    });
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId, "Upload Images Co", `upload-images-${accountId}@example.com`, "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId, accountId, "Upload Images WS", `route-${workspaceId}`,
    ]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM document_processing_jobs WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM document_images WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  /** Runs this workspace's queued jobs by id, as the task server would: the vectorize job, then the capture it queues. */
  const drainJobs = async (): Promise<void> => {
    for (let round = 0; round < 10; round += 1) {
      const queued = await database.query<{ id: string }>(
        "SELECT id FROM document_processing_jobs WHERE workspace_id = $1 AND status = 'queued' ORDER BY created_at",
        [workspaceId],
      );
      if (queued.length === 0) return;
      // Claimed a minute ahead: the database's clock, which stamps availability, may run ahead of this process's.
      for (const job of queued) await worker.runJobById(job.id, new Date(Date.now() + 60_000));
    }
  };

  it("stores a DOCX's pictures as inline images anchored to their chunks, and offers them to a grounded answer", async () => {
    const { documentId } = await imports.importDocument({ workspaceId, filename: "alpine-guide.docx", mimeType: DOCX, buffer: guide });
    await drainJobs();

    const rows = await images.listForCapture({ workspaceId, documentId });
    expect(rows.map((row) => [row.role, row.status])).toEqual([["inline", "stored"], ["inline", "stored"]]);
    expect(rows.every((row) => /^embedded:[0-9a-f]{64}$/.test(row.sourceUrl))).toBe(true);
    const chunkRows = await chunks.listSummariesForDocument({ documentId, workspaceId });
    expect(rows.map((row) => row.chunkId)).toEqual(chunkRows.map((chunk) => chunk.id));
    const listed = await images.listForDocument({ workspaceId, documentId, sharedDocumentCountLimit: 6 });
    expect(listed.map((image) => [image.alt, image.caption])).toEqual([
      ["Gentians on the ridge above the village", "Figure 1: Gentians in June"],
      ["Edelweiss on a ledge", null],
    ]);
    // The upload itself plus two WebP copies of each picture.
    expect(storage.objects.size).toBe(5);

    const { turnFactory } = createReplyBlocksComposition({
      env: { APP_BASE_URL: "https://agents.shop.example", CONNECTOR_PUBLIC_BASE_URL: undefined, PORT: 8080 },
      evidenceImages: images,
    });
    const offer = await turnFactory.forTurn({
      agent: { workspaceId, replyCardsEnabled: true },
      conversation: { id: randomUUID(), sourceChannel: "web" },
      replyBlocks: { item_list: { layouts: ["carousel", "grid"] } },
      retrieval: {
        contexts: chunkRows.map((chunk) => ({ documentId, chunkId: chunk.id, title: "Alpine Guide" })),
      },
    } as unknown as PreparedSession);

    expect(offer).not.toBeNull();
    expect(offer?.promptSection).toContain("[m1]");
    expect(offer?.promptSection).toContain("Figure 1: Gentians in June");
    expect(offer?.promptSection).toContain("Edelweiss on a ledge");
    expect(JSON.stringify(offer?.schemaExtension)).toContain("present");
  });
});
