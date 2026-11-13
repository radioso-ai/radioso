import { randomUUID } from "node:crypto";

import { crawlSite } from "@radioso/crawler";
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
  DocumentIngestionService,
  DocumentProcessingWorker,
  encodeDocumentImage,
  NoopDocumentJobDispatcher,
  type DocumentProcessingService,
} from "../../src/modules/documents/composition.js";
import type { DocumentImageFetcher } from "../../src/modules/documents/services/documentImageCaptureService.js";
import { toWebsiteCrawlPage } from "../../src/modules/websiteCrawler/radiosoCrawlerProvider.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { createAuditService, InMemoryDocumentStorage } from "../support/fakes.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const PAGE_URL = "https://shop.example/books/alpine-flowers";
const COVER_URL = "https://cdn.shop.example/covers/alpine.jpg";
const RIDGE_URL = "https://cdn.shop.example/photos/ridge.png";
const LEDGE_URL = "https://cdn.shop.example/photos/ledge.png";
const PIXEL_URL = "https://track.shop.example/pixel.gif";

const PARAGRAPH = "The guide walks through every meadow above the tree line, season by season, with notes on where each flower grows and when it opens.";

const FIXTURE_PAGE = `<!doctype html>
<html><head>
  <title>A Field Guide to Alpine Flowers</title>
  <meta property="og:image" content="${COVER_URL}">
</head><body>
  <header><img src="https://shop.example/logo.png" alt="Shop"></header>
  <main>
    <h1>A Field Guide to Alpine Flowers</h1>
    <p>${PARAGRAPH}</p>
    <figure><img src="${RIDGE_URL}" alt="Gentians in bloom"><figcaption>Gentians on the ridge above the village</figcaption></figure>
    <p>${PARAGRAPH} Edelweiss grows on limestone ledges and opens late in the summer, long after the gentians.</p>
    <img src="${PIXEL_URL}" alt="">
    <p>${PARAGRAPH} The last chapter covers the autumn crocus and the meadows that keep it.</p>
    <img src="${LEDGE_URL}" alt="Edelweiss on a ledge">
    <p>${PARAGRAPH} An index of every species closes the guide, with the valley each one is found in.</p>
  </main>
</body></html>`;

/** Serves the fixture page and nothing else; robots.txt and every other address are not found. */
const pageFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return url === PAGE_URL
    ? new Response(FIXTURE_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
    : new Response("not found", { status: 404 });
}) as typeof fetch;

const solid = (width: number, height: number, format: "png" | "jpeg" | "gif") =>
  sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 200 } } })[format]().toBuffer();

describeIntegration("document image capture, from a crawled page to an answer's offer (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const documents = new DocumentRepository(database.kysely);
  const jobs = new DocumentProcessingJobRepository(database.kysely);
  const images = new DocumentImageRepository(database.kysely);
  const chunks = new ChunkRepository(database);
  const storage = new InMemoryDocumentStorage();
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const logger = createLogger("silent");
  let sources: Record<string, Buffer>;

  const fetchImage: DocumentImageFetcher = async (url) => {
    const bytes = sources[url];
    return bytes ? { kind: "fetched", bytes, contentType: null, url, etag: `"${url.length}"` } : { kind: "failed", reason: "unreachable" };
  };

  /** Stands in for chunking and embedding: cuts the stored text at its paragraphs and publishes the chunks. */
  const processingService = {
    process: vi.fn(async (job: DocumentProcessingJobRecord) => {
      const document = await documents.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
      if (!document) return "deleted";
      const text = document.markdownContent;
      const cut = text.indexOf("Edelweiss grows");
      const pieces = [[0, cut], [cut, text.length]] as const;
      await database.query("DELETE FROM chunks WHERE document_id = $1", [document.id]);
      for (const [index, [start, end]] of pieces.entries()) {
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
  const queue = new DocumentImageCaptureQueue({ images, jobs, dispatcher, logger });
  const capture = new DocumentImageCaptureService({ images, documents, chunks, storage, fetchImage, encodeImage: encodeDocumentImage, logger });
  const ingestion = new DocumentIngestionService(
    documents, createAuditService(), undefined, undefined, dispatcher, undefined, undefined, undefined, undefined,
    createNoopWorkspaceInvalidationPublisher(), { recordCandidates: (input) => queue.recordCandidates(input) },
  );
  const worker = new DocumentProcessingWorker(
    documents, jobs, processingService, createAuditService(), logger, 1_000, dispatcher, 300_000,
    undefined, undefined, undefined, undefined, undefined, undefined, createNoopWorkspaceInvalidationPublisher(),
    {
      capture: (job) => capture.capture(job),
      afterRevisionPublished: (job) => queue.afterRevisionPublished(job),
      sweepReleased: () => capture.sweepReleased(),
    },
  );

  beforeAll(async () => {
    sources = {
      [COVER_URL]: await solid(1200, 900, "jpeg"),
      [RIDGE_URL]: await solid(800, 600, "png"),
      [LEDGE_URL]: await solid(640, 960, "png"),
      [PIXEL_URL]: await solid(1, 1, "gif"),
    };
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId, "Image Capture Co", `image-capture-${accountId}@example.com`, "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId, accountId, "Image Capture WS", `route-${workspaceId}`,
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

  it("stores the page's picture and its content images, anchored to their chunks, and offers them to a grounded answer", async () => {
    const [crawled] = await crawlSite({ baseUrl: PAGE_URL, pageLimit: 1, includeBaseUrl: true, fetchImpl: pageFetch });
    const page = toWebsiteCrawlPage(crawled);

    const { documentId } = await ingestion.ingest({
      workspaceId,
      title: page.title ?? PAGE_URL,
      content: page.content,
      externalDocumentId: `website:${PAGE_URL}`,
      metadata: { sourceUrl: PAGE_URL },
      images: page.images,
    });
    await drainJobs();

    const rows = await images.listForCapture({ workspaceId, documentId });
    expect(rows.map((row) => [row.sourceUrl, row.role, row.status])).toEqual([
      [COVER_URL, "primary", "stored"],
      [RIDGE_URL, "inline", "stored"],
      [PIXEL_URL, "inline", "skipped"],
      [LEDGE_URL, "inline", "stored"],
    ]);
    const chunkRows = await chunks.listSummariesForDocument({ documentId, workspaceId });
    const [firstChunk, secondChunk] = chunkRows;
    expect(rows.find((row) => row.sourceUrl === RIDGE_URL)?.chunkId).toBe(firstChunk?.id);
    expect(rows.find((row) => row.sourceUrl === LEDGE_URL)?.chunkId).toBe(secondChunk?.id);
    expect(storage.objects.size).toBe(6);

    const { turnFactory } = createReplyBlocksComposition({
      env: { APP_BASE_URL: "https://agents.shop.example", CONNECTOR_PUBLIC_BASE_URL: undefined, PORT: 8080 },
      evidenceImages: images,
    });
    const offer = await turnFactory.forTurn({
      agent: { workspaceId, replyCardsEnabled: true },
      conversation: { id: randomUUID(), sourceChannel: "web" },
      replyBlocks: { item_list: { layouts: ["carousel", "grid"] } },
      retrieval: {
        contexts: chunkRows.map((chunk) => ({
          documentId, chunkId: chunk.id, title: "A Field Guide to Alpine Flowers", metadata: { sourceUrl: PAGE_URL },
        })),
      },
    } as unknown as PreparedSession);

    expect(offer).not.toBeNull();
    expect(offer?.promptSection).toContain("[m1]");
    expect(offer?.promptSection).toContain("Gentians");
    expect(JSON.stringify(offer?.schemaExtension)).toContain("present");
  });

  it("drops an image the page no longer shows on the next crawl, its row and its copies", async () => {
    const changedPage = FIXTURE_PAGE.replace(`<img src="${LEDGE_URL}" alt="Edelweiss on a ledge">`, "");
    const changedFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url === PAGE_URL
        ? new Response(changedPage.replace("An index of every species", "A full index of every species"), { status: 200, headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 });
    }) as typeof fetch;
    const [crawled] = await crawlSite({ baseUrl: PAGE_URL, pageLimit: 1, includeBaseUrl: true, fetchImpl: changedFetch });
    const page = toWebsiteCrawlPage(crawled);
    const before = await database.query<{ id: string }>("SELECT id FROM document_images WHERE source_url = $1 AND workspace_id = $2", [LEDGE_URL, workspaceId]);

    await ingestion.ingest({
      workspaceId,
      title: page.title ?? PAGE_URL,
      content: page.content,
      externalDocumentId: `website:${PAGE_URL}`,
      metadata: { sourceUrl: PAGE_URL },
      images: page.images,
    });
    await drainJobs();

    await expect(database.query("SELECT id FROM document_images WHERE id = $1", [before[0]?.id])).resolves.toEqual([]);
    expect([...storage.objects.keys()].some((path) => path.includes(before[0]?.id ?? "missing"))).toBe(false);
    expect(storage.objects.size).toBe(4);
  });
});
