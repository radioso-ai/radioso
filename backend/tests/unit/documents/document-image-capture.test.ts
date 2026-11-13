import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import type { DocumentProcessingJobRecord } from "../../../src/db/repositories/documentProcessingJobRepository.js";
import { encodeDocumentImage } from "../../../src/modules/documents/infra/documentImageCodec.js";
import {
  DocumentImageCaptureService,
  type DocumentImageFetcher,
} from "../../../src/modules/documents/services/documentImageCaptureService.js";
import type { PublicBytesFetchResult } from "../../../src/shared/infra/http/publicBytesFetch.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import { InMemoryDocumentStorage } from "../../support/fakes.js";
import { InMemoryDocumentImageRows } from "../../support/inMemoryDocumentImageRows.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

const job = (overrides: Partial<DocumentProcessingJobRecord> = {}): DocumentProcessingJobRecord => ({
  id: "job-1",
  documentId: DOCUMENT_ID,
  workspaceId: WORKSPACE_ID,
  documentRevision: 3,
  kind: "images",
  status: "processing",
  attemptCount: 1,
  lastError: null,
  availableAt: new Date(),
  claimedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const solid = (width: number, height: number, format: "png" | "jpeg" = "png") =>
  sharp({ create: { width, height, channels: 3, background: { r: 120, g: 160, b: 90 } } })[format]().toBuffer();

let cover: Buffer;
let pixel: Buffer;
let ridge: Buffer;

beforeAll(async () => {
  cover = await solid(1200, 900, "jpeg");
  pixel = await solid(1, 1);
  ridge = await solid(800, 600);
});

/** Answers each address with what the test set for it; an address it was not given is unreachable. */
const fetcherServing = (responses: Record<string, PublicBytesFetchResult>) => {
  const asked: Array<{ url: string; ifNoneMatch: string | null }> = [];
  const fetchImage: DocumentImageFetcher = async (url, options) => {
    asked.push({ url, ifNoneMatch: options.ifNoneMatch });
    return responses[url] ?? { kind: "failed", reason: "unreachable" };
  };
  return { fetchImage, asked };
};

const fetched = (bytes: Buffer, etag?: string): PublicBytesFetchResult =>
  ({ kind: "fetched", bytes, contentType: "image/png", url: "https://cdn.shop.example/x", ...(etag ? { etag } : {}) });

const setup = (options: {
  responses: Record<string, PublicBytesFetchResult>;
  document?: { revision: number; metadata?: Record<string, unknown> } | null;
  chunks?: Array<{ id: string; startOffset: number; endOffset: number }>;
}) => {
  const rows = new InMemoryDocumentImageRows();
  const storage = new InMemoryDocumentStorage();
  const metrics = new MetricsRegistry();
  const { fetchImage, asked } = fetcherServing(options.responses);
  const document = options.document === undefined ? { revision: 3, metadata: { sourceUrl: "https://shop.example/books/alpine" } } : options.document;
  const service = new DocumentImageCaptureService({
    images: rows,
    documents: { findByIdAndWorkspaceId: async () => (document ? { id: DOCUMENT_ID, ...document } : null) },
    chunks: {
      listSummariesForDocument: async () => (options.chunks ?? []).map((chunk, index) => ({
        ...chunk, chunkIndex: index, contentPreview: "", contentLength: chunk.endOffset - chunk.startOffset, dateFrom: null, dateTo: null,
      })),
    },
    storage,
    fetchImage,
    encodeImage: encodeDocumentImage,
    metrics,
  });
  const seed = (sourceUrl: string, role: "primary" | "inline", extra: Partial<Parameters<InMemoryDocumentImageRows["seed"]>[0]> = {}) =>
    rows.seed({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, sourceUrl, role, ...extra });
  const captured = (outcome: string, source = "crawler_metadata") =>
    metrics.renderPrometheus().includes(`document_image_capture_total{outcome="${outcome}",source="${source}"}`)
      || metrics.renderPrometheus().includes(`document_image_capture_total{source="${source}",outcome="${outcome}"}`);
  return { service, rows, storage, metrics, asked, seed, captured };
};

describe("DocumentImageCaptureService", () => {
  it("stores each named image as WebP at every rendition width and anchors an inline image to its chunk", async () => {
    const { service, rows, storage, seed, captured } = setup({
      responses: {
        "https://cdn.shop.example/cover.jpg": fetched(cover, '"cover-v1"'),
        "https://cdn.shop.example/ridge.png": fetched(ridge),
      },
      chunks: [{ id: "chunk-a", startOffset: 0, endOffset: 120 }, { id: "chunk-b", startOffset: 120, endOffset: 400 }],
    });
    const primary = seed("https://cdn.shop.example/cover.jpg", "primary", { position: 0 });
    const inline = seed("https://cdn.shop.example/ridge.png", "inline", { position: 1, textOffset: 180 });

    await expect(service.capture(job())).resolves.toBe("completed");

    expect(rows.rows.get(primary.id)).toMatchObject({ status: "stored", width: 1200, height: 900, sourceEtag: '"cover-v1"', chunkId: null });
    expect(rows.rows.get(primary.id)?.renditions.map((rendition) => [rendition.width, rendition.height])).toEqual([[320, 240], [640, 480]]);
    expect(rows.rows.get(inline.id)).toMatchObject({ status: "stored", chunkId: "chunk-b", width: 800, height: 600 });
    expect([...storage.objects.keys()].sort()).toEqual([
      `workspaces/${WORKSPACE_ID}/documents/document-image-${primary.id}-w320`,
      `workspaces/${WORKSPACE_ID}/documents/document-image-${primary.id}-w640`,
      `workspaces/${WORKSPACE_ID}/documents/document-image-${inline.id}-w320`,
      `workspaces/${WORKSPACE_ID}/documents/document-image-${inline.id}-w640`,
    ].sort());
    const stored = storage.objects.get(`workspaces/${WORKSPACE_ID}/documents/document-image-${primary.id}-w640`);
    expect((await sharp(stored?.buffer).metadata()).format).toBe("webp");
    expect(captured("stored")).toBe(true);
    expect(captured("stored", "crawler_inline")).toBe(true);
  });

  it("skips what it will not keep, leaves what may work next time pending, and never fails the job", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"></svg>');
    const truncatedPng = Buffer.concat([ridge.subarray(0, 64), Buffer.alloc(64)]);
    const { service, rows, storage, seed, captured } = setup({
      responses: {
        "https://cdn.shop.example/pixel.png": fetched(pixel),
        "https://cdn.shop.example/logo.svg-as-png": fetched(svg),
        "https://cdn.shop.example/broken.png": fetched(truncatedPng),
        "https://cdn.shop.example/huge.jpg": { kind: "failed", reason: "too_large" },
        "https://intranet.shop.example/a.jpg": { kind: "failed", reason: "blocked" },
        "https://cdn.shop.example/slow.jpg": { kind: "failed", reason: "timeout" },
      },
    });
    const ids = Object.fromEntries([
      "https://cdn.shop.example/pixel.png",
      "https://cdn.shop.example/logo.svg-as-png",
      "https://cdn.shop.example/broken.png",
      "https://cdn.shop.example/huge.jpg",
      "https://intranet.shop.example/a.jpg",
      "https://cdn.shop.example/slow.jpg",
    ].map((url, position) => [url, seed(url, "primary", { position }).id]));

    await expect(service.capture(job())).resolves.toBe("completed");

    const statusOf = (url: string) => rows.rows.get(ids[url] ?? "")?.status;
    expect(statusOf("https://cdn.shop.example/pixel.png")).toBe("skipped");
    expect(statusOf("https://cdn.shop.example/logo.svg-as-png")).toBe("skipped");
    expect(statusOf("https://cdn.shop.example/broken.png")).toBe("skipped");
    expect(statusOf("https://cdn.shop.example/huge.jpg")).toBe("skipped");
    expect(statusOf("https://intranet.shop.example/a.jpg")).toBe("skipped");
    expect(statusOf("https://cdn.shop.example/slow.jpg")).toBe("pending");
    expect(storage.objects.size).toBe(0);
    for (const outcome of ["too_small", "unsupported_type", "decode_error", "too_large", "blocked_address", "timeout"]) {
      expect(captured(outcome), outcome).toBe(true);
    }
  });

  it("reuses a stored image whose source answers that it has not changed, moving only its anchor", async () => {
    const { service, rows, storage, asked, seed, captured } = setup({
      responses: { "https://cdn.shop.example/ridge.png": { kind: "not_modified", url: "https://cdn.shop.example/ridge.png" } },
      chunks: [{ id: "chunk-new", startOffset: 0, endOffset: 500 }],
    });
    const stored = seed("https://cdn.shop.example/ridge.png", "inline", {
      status: "stored", sourceEtag: '"r1"', sha256: "sha-ridge", textOffset: 40, chunkId: "chunk-old", width: 800, height: 600,
      renditions: [{ width: 640, height: 480, bucket: "b", objectPath: "p", generation: "1", sizeBytes: 10 }],
    });

    await service.capture(job());

    expect(asked).toEqual([{ url: "https://cdn.shop.example/ridge.png", ifNoneMatch: '"r1"' }]);
    expect(rows.rows.get(stored.id)).toMatchObject({ status: "stored", chunkId: "chunk-new", sha256: "sha-ridge" });
    expect(storage.objects.size).toBe(0);
    expect(captured("reused", "crawler_inline")).toBe(true);
  });

  it("reuses a stored image whose bytes are the same when the source sends no entity tag", async () => {
    const { createHash } = await import("node:crypto");
    const { service, storage, seed, captured } = setup({ responses: { "https://cdn.shop.example/cover.jpg": fetched(cover) } });
    seed("https://cdn.shop.example/cover.jpg", "primary", {
      status: "stored", sha256: createHash("sha256").update(cover).digest("hex"), width: 1200, height: 900,
      renditions: [{ width: 640, height: 480, bucket: "b", objectPath: "p", generation: "1", sizeBytes: 10 }],
    });

    await service.capture(job());

    expect(storage.objects.size).toBe(0);
    expect(captured("reused")).toBe(true);
  });

  it("keeps at most twelve images per document, in document order, without fetching the rest", async () => {
    const urls = Array.from({ length: 14 }, (_value, index) => `https://cdn.shop.example/g${index}.png`);
    const { service, rows, asked, seed } = setup({ responses: Object.fromEntries(urls.map((url) => [url, fetched(ridge)])) });
    urls.forEach((url, position) => seed(url, "inline", { position, textOffset: 0 }));

    await service.capture(job());

    expect(rows.forDocument(DOCUMENT_ID).filter((row) => row.status === "stored")).toHaveLength(12);
    expect(rows.byUrl(urls[12] ?? "")?.status).toBe("pending");
    expect(asked.map((entry) => entry.url)).toEqual(urls.slice(0, 12));
  });

  it("does nothing for a document that is gone or has moved to a newer revision", async () => {
    const gone = setup({ responses: {}, document: null });
    gone.seed("https://cdn.shop.example/cover.jpg", "primary");
    const moved = setup({ responses: {}, document: { revision: 4 } });
    moved.seed("https://cdn.shop.example/cover.jpg", "primary");

    await expect(gone.service.capture(job())).resolves.toBe("deleted");
    await expect(moved.service.capture(job())).resolves.toBe("stale");
    expect(gone.asked).toEqual([]);
    expect(moved.asked).toEqual([]);
  });

  it("labels a WordPress document's metadata picture as its featured image", async () => {
    const { service, seed, captured } = setup({
      responses: { "https://cdn.shop.example/cover.jpg": fetched(cover) },
      document: { revision: 3, metadata: { source: "wordpress", sourceUrl: "https://shop.example/?p=7" } },
    });
    seed("https://cdn.shop.example/cover.jpg", "primary");

    await service.capture(job());

    expect(captured("stored", "wordpress_featured")).toBe(true);
  });

  it("deletes the copies it wrote when the row went away while it worked", async () => {
    const { service, rows, storage, seed } = setup({ responses: { "https://cdn.shop.example/cover.jpg": fetched(cover) } });
    const row = seed("https://cdn.shop.example/cover.jpg", "primary");
    const markStored = rows.markStored.bind(rows);
    rows.markStored = async (input) => {
      rows.rows.delete(row.id);
      return markStored(input);
    };

    await service.capture(job());

    expect(storage.objects.size).toBe(0);
  });

  it("sweeps released images: their copies first, then their rows", async () => {
    const { service, rows, storage } = setup({ responses: {} });
    const copy = await storage.upload({ workspaceId: WORKSPACE_ID, documentId: "document-image-gone-w640", filename: "image.webp", mimeType: "image/webp", buffer: Buffer.from("x") });
    const released = rows.seed({
      workspaceId: WORKSPACE_ID, documentId: null, sourceUrl: "https://cdn.shop.example/gone.jpg", role: "primary", status: "stored",
      renditions: [{ width: 640, height: 480, bucket: copy.bucket, objectPath: copy.objectPath, generation: copy.generation ?? null, sizeBytes: 1 }],
    });
    const live = rows.seed({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, sourceUrl: "https://cdn.shop.example/live.jpg", role: "primary" });

    await service.sweepReleased();

    expect(storage.objects.has(copy.objectPath)).toBe(false);
    expect(rows.rows.has(released.id)).toBe(false);
    expect(rows.rows.has(live.id)).toBe(true);
  });
});
