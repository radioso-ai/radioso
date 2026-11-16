import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import { parseDocument } from "@radioso/document-parser";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import type { DocumentProcessingJobRecord } from "../../../src/db/repositories/documentProcessingJobRepository.js";
import { encodeDocumentImage } from "../../../src/modules/documents/infra/documentImageCodec.js";
import {
  DocumentImageCaptureService,
  type DocumentImageFetcher,
} from "../../../src/modules/documents/services/documentImageCaptureService.js";
import { UploadedFileImages } from "../../../src/modules/documents/services/uploadedFileImages.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import { buildDocx, buildPdf } from "../../support/documentFileFixtures.js";
import { InMemoryDocumentStorage } from "../../support/fakes.js";
import { InMemoryDocumentImageRows } from "../../support/inMemoryDocumentImageRows.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const job: DocumentProcessingJobRecord = {
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
};

const solid = (width: number, height: number, format: "png" | "jpeg") =>
  sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 60 } } })[format]().toBuffer();

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const pngChunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
  return Buffer.concat([length, Buffer.from(type), data, crc]);
};

/** A well-formed PNG header declaring 20,000 by 20,000 pixels, over a few bytes of data. */
const oversizedPng = (): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(20_000, 0);
  header.writeUInt32BE(20_000, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc(64))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

let ridge: Buffer;
let ledge: Buffer;
let meadow: Buffer;

beforeAll(async () => {
  ridge = await solid(800, 600, "png");
  ledge = await solid(640, 480, "jpeg");
  meadow = await solid(400, 300, "jpeg");
});

const guide = (media: Record<string, Buffer>, withLedge = true) => buildDocx({
  paragraphs: [
    { text: "The guide walks through every meadow above the tree line, season by season." },
    { image: { media: "media/image1.png", descr: "Gentians on the ridge" } },
    { text: "Figure 1: The ridge above the village", styleId: "Caption" },
    { text: "Edelweiss grows on limestone ledges and opens late in the summer." },
    ...(withLedge ? [{ image: { media: "media/image2.jpeg", title: "Edelweiss on a ledge" } }] : []),
    { text: "An index of every species closes the guide." },
  ],
  media,
  styles: [{ id: "Caption", name: "caption" }],
});

/** An uploaded file in storage, its document as the vectorize job left it, and chunks cut at a passage. */
const setup = async (options: {
  file: Buffer;
  filename: string;
  mimeType: string;
  cutAt?: string;
  responses?: Record<string, Buffer>;
}) => {
  const rows = new InMemoryDocumentImageRows();
  const storage = new InMemoryDocumentStorage();
  const metrics = new MetricsRegistry();
  const stored = await storage.upload({
    workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, folder: "documents", filename: options.filename, mimeType: options.mimeType, buffer: options.file,
  });
  const parsed = await parseDocument({ buffer: options.file, filename: options.filename, mimeType: options.mimeType });
  const text = parsed.markdown;
  const cut = options.cutAt ? text.indexOf(options.cutAt) : text.length;
  const chunks = [{ id: "chunk-a", startOffset: 0, endOffset: cut }, { id: "chunk-b", startOffset: cut, endOffset: text.length }];
  const document = {
    id: DOCUMENT_ID,
    revision: 3,
    metadata: {},
    sourceKind: "uploaded_file" as const,
    sourceFilename: options.filename,
    sourceMimeType: options.mimeType,
    sourceStorageBucket: stored.bucket,
    sourceStorageObject: stored.objectPath,
    sourceStorageGeneration: stored.generation ?? null,
    markdownContent: text,
  };
  const fetched: string[] = [];
  const fetchImage: DocumentImageFetcher = async (url) => {
    fetched.push(url);
    const bytes = options.responses?.[url];
    return bytes ? { kind: "fetched", bytes, contentType: "image/png", url } : { kind: "failed", reason: "unreachable" };
  };
  const service = new DocumentImageCaptureService({
    images: rows,
    documents: { findByIdAndWorkspaceId: async () => document },
    chunks: {
      listSummariesForDocument: async () => chunks.map((chunk, index) => ({
        ...chunk, chunkIndex: index, contentPreview: "", contentLength: chunk.endOffset - chunk.startOffset, dateFrom: null, dateTo: null,
      })),
    },
    storage,
    fetchImage,
    encodeImage: encodeDocumentImage,
    uploadedFiles: new UploadedFileImages({ storage, images: rows }),
    metrics,
  });
  const captured = (outcome: string, source: string) => {
    const rendered = metrics.renderPrometheus();
    return rendered.includes(`document_image_capture_total{outcome="${outcome}",source="${source}"}`)
      || rendered.includes(`document_image_capture_total{source="${source}",outcome="${outcome}"}`);
  };
  const imageObjects = () => [...storage.objects.keys()].filter((path) => path.includes("document-image-"));
  return { service, rows, storage, document, text, captured, imageObjects, fetched };
};

describe("capturing the pictures an uploaded file carries", () => {
  it("stores the pictures a DOCX embeds as inline images under their content keys, anchored to their chunks", async () => {
    const { service, rows, captured, imageObjects } = await setup({
      file: guide({ "media/image1.png": ridge, "media/image2.jpeg": ledge }),
      filename: "guide.docx", mimeType: DOCX, cutAt: "Edelweiss grows",
    });

    await expect(service.capture(job)).resolves.toBe("completed");

    expect(rows.forDocument(DOCUMENT_ID).map((row) => ({
      sourceUrl: row.sourceUrl, role: row.role, status: row.status, chunkId: row.chunkId, alt: row.alt, caption: row.caption, width: row.width,
    }))).toEqual([
      { sourceUrl: `embedded:${sha256(ridge)}`, role: "inline", status: "stored", chunkId: "chunk-a", alt: "Gentians on the ridge", caption: "Figure 1: The ridge above the village", width: 800 },
      { sourceUrl: `embedded:${sha256(ledge)}`, role: "inline", status: "stored", chunkId: "chunk-b", alt: "Edelweiss on a ledge", caption: null, width: 640 },
    ]);
    // Only the WebP copies are written: the uploaded file is the one copy of the original bytes.
    expect(imageObjects()).toHaveLength(4);
    expect(captured("stored", "docx")).toBe(true);
  });

  it("reuses a stored picture when the file is processed again, and releases one the file no longer carries", async () => {
    const { service, rows, storage, document, imageObjects } = await setup({
      file: guide({ "media/image1.png": ridge, "media/image2.jpeg": ledge }),
      filename: "guide.docx", mimeType: DOCX, cutAt: "Edelweiss grows",
    });
    await service.capture(job);
    const [kept] = rows.forDocument(DOCUMENT_ID);
    const before = imageObjects();

    const replaced = await storage.upload({
      workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, folder: "documents", filename: "guide.docx", mimeType: DOCX,
      buffer: guide({ "media/image1.png": ridge }, false),
    });
    document.sourceStorageGeneration = replaced.generation ?? null;
    document.markdownContent = (await parseDocument({ buffer: guide({ "media/image1.png": ridge }, false), filename: "guide.docx", mimeType: DOCX })).markdown;
    await service.capture(job);

    expect(rows.forDocument(DOCUMENT_ID).map((row) => [row.id, row.status])).toEqual([[kept?.id, "stored"]]);
    expect(rows.byUrl(`embedded:${sha256(ledge)}`)?.documentId).toBeNull();
    expect(imageObjects()).toEqual(before);
  });

  it("does not keep a malformed or oversized picture, and the document still completes", async () => {
    const { service, rows, captured } = await setup({
      file: guide({ "media/image1.png": Buffer.from("not an image at all"), "media/image2.jpeg": oversizedPng() }),
      filename: "guide.docx", mimeType: DOCX,
    });

    await expect(service.capture(job)).resolves.toBe("completed");

    expect(rows.forDocument(DOCUMENT_ID).map((row) => row.status)).toEqual(["skipped", "skipped"]);
    expect(captured("unsupported_type", "docx")).toBe(true);
    expect(captured("too_large", "docx")).toBe(true);
  });

  it("anchors a PDF's picture to the chunk where its page's text starts", async () => {
    const file = buildPdf([
      { text: "Alpine flowers of the high meadows, a field guide" },
      { text: "Gentians open in June on the ridge", images: [{ width: 400, height: 300, filter: "DCTDecode", data: meadow }] },
    ]);
    const { service, rows, captured } = await setup({ file, filename: "flowers.pdf", mimeType: "application/pdf", cutAt: "Gentians open" });

    await service.capture(job);

    const [image] = rows.forDocument(DOCUMENT_ID);
    expect(image).toMatchObject({ role: "inline", status: "stored", chunkId: "chunk-b", width: 400, height: 300 });
    expect(image?.sourceUrl).toMatch(/^embedded:[0-9a-f]{64}$/);
    expect(captured("stored", "pdf")).toBe(true);
  });

  it("fetches the images a markdown upload links, never a data URI", async () => {
    const file = Buffer.from([
      "# Alpine flowers",
      "",
      "![Gentians on the ridge](https://cdn.example/gentians.png)",
      "",
      "![Inline](data:image/png;base64,iVBORw0KGgo=)",
    ].join("\n"));
    const { service, rows, captured, fetched } = await setup({
      file, filename: "flowers.md", mimeType: "text/markdown", responses: { "https://cdn.example/gentians.png": ridge },
    });

    await service.capture(job);

    expect(fetched).toEqual(["https://cdn.example/gentians.png"]);
    expect(rows.forDocument(DOCUMENT_ID).map((row) => [row.sourceUrl, row.status, row.alt])).toEqual([
      ["https://cdn.example/gentians.png", "stored", "Gentians on the ridge"],
    ]);
    expect(captured("stored", "markdown")).toBe(true);
  });

  it("keeps a stored picture and leaves a new one pending when the file cannot be read", async () => {
    const { service, rows, storage, document } = await setup({
      file: guide({ "media/image1.png": ridge, "media/image2.jpeg": ledge }),
      filename: "guide.docx", mimeType: DOCX,
    });
    await service.capture(job);
    storage.objects.delete(document.sourceStorageObject);
    const [first] = rows.forDocument(DOCUMENT_ID);
    rows.seed({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, sourceUrl: `embedded:${"a".repeat(64)}`, role: "inline", position: 2 });

    await expect(service.capture(job)).resolves.toBe("completed");

    expect(rows.forDocument(DOCUMENT_ID).map((row) => row.status)).toEqual(["stored", "stored", "pending"]);
    expect(rows.forDocument(DOCUMENT_ID)[0]?.id).toBe(first?.id);
  });
});
