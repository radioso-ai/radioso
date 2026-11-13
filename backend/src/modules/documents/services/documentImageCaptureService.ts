import { createHash } from "node:crypto";

import type { DocumentProcessingJobRecord } from "../../../db/repositories/documentProcessingJobRepository.js";
import type { PublicBytesFetchResult } from "../../../shared/infra/http/publicBytesFetch.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { ChunkRepositoryPort, ChunkSummary } from "../contracts/documentContracts.js";
import type {
  CapturableDocumentImage,
  DocumentImageCaptureStore,
  DocumentImageRendition,
  ReleasedDocumentImageStore,
} from "../contracts/documentImages.js";
import type { DocumentStoragePort } from "../contracts/storage.js";

/** A document keeps at most this many images; the rest of what its content names waits, unfetched. */
const MAX_IMAGES_PER_DOCUMENT = 12;
/** Icons, spacers and tracking pixels are smaller than this on their short side. */
const MIN_SHORT_SIDE_PX = 200;
/** One job's share of the worker's lease: images not reached by then wait for the next capture. */
const CAPTURE_BUDGET_MS = 150_000;
/** Released rows the worker clears after each job. */
const SWEEP_BATCH = 50;

/** Fetches one image a document names; `ifNoneMatch` asks whether a stored one changed. */
export type DocumentImageFetcher = (url: string, options: { ifNoneMatch: string | null }) => Promise<PublicBytesFetchResult>;

export type EncodedDocumentImage =
  | {
      kind: "encoded";
      /** The upright size of the source. */
      width: number;
      height: number;
      /** One WebP per rendition width, in that order; `slotWidth` is the width asked for, `width` what was produced. */
      renditions: Array<{ slotWidth: number; width: number; height: number; webp: Buffer }>;
    }
  | { kind: "refused"; reason: "too_small" | "unsupported_type" | "too_large" | "decode_error" | "busy" };

/** Decodes under the codec's guard and re-encodes to the stored widths, refusing an image under the floor. */
export type DocumentImageEncoder = (bytes: Buffer, options: { minShortSidePx: number }) => Promise<EncodedDocumentImage>;

/** What became of one image. `timeout`, `unreachable` and `busy` leave it pending for the next capture. */
type CaptureOutcome =
  | "stored"
  | "reused"
  | "too_small"
  | "unsupported_type"
  | "too_large"
  | "blocked_address"
  | "timeout"
  | "decode_error"
  | "unreachable"
  | "busy";

const RETRIED_OUTCOMES = new Set<CaptureOutcome>(["timeout", "unreachable", "busy"]);

const FETCH_FAILURE_OUTCOMES: Readonly<Record<Extract<PublicBytesFetchResult, { kind: "failed" }>["reason"], CaptureOutcome>> = {
  blocked: "blocked_address",
  timeout: "timeout",
  too_large: "too_large",
  content_type: "unsupported_type",
  http_status: "unreachable",
  too_many_redirects: "unreachable",
  unreachable: "unreachable",
};

interface CaptureDependencies {
  images: DocumentImageCaptureStore & ReleasedDocumentImageStore;
  documents: {
    findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<{ revision: number; metadata?: Record<string, unknown> | null } | null>;
  };
  chunks: Pick<ChunkRepositoryPort, "listSummariesForDocument">;
  storage: DocumentStoragePort;
  fetchImage: DocumentImageFetcher;
  encodeImage: DocumentImageEncoder;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  logger?: Pick<AppLogger, "warn">;
  now?: () => number;
}

/**
 * Where an image came from, as a bounded metric label. The WordPress connector marks its documents'
 * metadata with `source: "wordpress"`; every other document with images came from a crawl.
 */
const captureSourceLabel = (metadata: Record<string, unknown> | null | undefined, image: CapturableDocumentImage): string => {
  if (metadata?.source === "wordpress") return image.role === "primary" ? "wordpress_featured" : "wordpress_inline";
  return image.role === "primary" ? "crawler_metadata" : "crawler_inline";
};

/** The chunk whose text holds the offset; past the last chunk's end, the last chunk that starts before it. */
const anchorChunk = (chunks: readonly ChunkSummary[], image: CapturableDocumentImage): string | null => {
  if (image.role !== "inline" || image.textOffset === null) return null;
  const offset = image.textOffset;
  const containing = chunks.find((chunk) => chunk.startOffset <= offset && offset < chunk.endOffset);
  if (containing) return containing.id;
  return chunks.filter((chunk) => chunk.startOffset <= offset).at(-1)?.id ?? null;
};

const objectLeaf = (imageId: string, slotWidth: number): string => `document-image-${imageId}-w${slotWidth}`;

/**
 * The document worker's `images` job: fetches each image a document's content names, re-encodes
 * it, stores the copies and fills its row, anchored to the published chunks. A stored image whose
 * source has not changed is reused. A failed image never fails the job: an image capture will not
 * keep is marked skipped, one that may work next time stays pending. It also sweeps the images that
 * deleted documents and re-syncs released.
 */
export class DocumentImageCaptureService {
  constructor(private readonly deps: CaptureDependencies) {}

  async capture(job: DocumentProcessingJobRecord): Promise<"completed" | "stale" | "deleted"> {
    return traceOperation({
      name: "document.images.capture",
      attributes: { "radioso.workspace_id": job.workspaceId, "radioso.document_id": job.documentId, "document.revision": job.documentRevision },
      run: () => this.captureDocument(job),
      resultAttributes: (outcome) => ({ "document.images.outcome": outcome }),
    });
  }

  /** Deletes the stored copies of a batch of released images, then their rows. Never throws. */
  async sweepReleased(): Promise<void> {
    try {
      const released = await this.deps.images.listReleased(SWEEP_BATCH);
      if (released.length === 0) return;
      for (const image of released) {
        await this.deleteCopies(image.renditions);
      }
      await this.deps.images.deleteReleased(released.map((image) => image.id));
    } catch (error) {
      this.deps.logger?.warn({ err: error }, "Released document images could not be swept; the next job retries");
    }
  }

  private async captureDocument(job: DocumentProcessingJobRecord): Promise<"completed" | "stale" | "deleted"> {
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const document = await this.deps.documents.findByIdAndWorkspaceId(job.documentId, job.workspaceId);
    if (!document) return "deleted";
    if (document.revision !== job.documentRevision) return "stale";
    const images = await this.deps.images.listForCapture({ workspaceId: job.workspaceId, documentId: job.documentId });
    const chunks = images.some((image) => image.role === "inline")
      ? await this.deps.chunks.listSummariesForDocument({ documentId: job.documentId, workspaceId: job.workspaceId })
      : [];
    let kept = 0;
    for (const image of images) {
      if (image.status === "skipped") continue;
      if (kept >= MAX_IMAGES_PER_DOCUMENT) {
        if (image.status === "stored") await this.deleteCopies(await this.deps.images.resetToPending(image.id));
        continue;
      }
      if (now() - startedAt > CAPTURE_BUDGET_MS) break;
      const outcome = await this.captureImage(job, image, anchorChunk(chunks, image));
      if (outcome === "stored" || outcome === "reused" || (image.status === "stored" && RETRIED_OUTCOMES.has(outcome))) kept += 1;
      this.deps.metrics?.incrementCounter("document_image_capture_total", {
        help: "Images named by documents' content that capture fetched, by where they came from and what became of them",
        labels: { source: captureSourceLabel(document.metadata, image), outcome },
      });
    }
    this.deps.metrics?.observeHistogram("document_image_capture_duration_seconds", {
      help: "Time one document's image capture took, fetches and re-encoding included",
      value: (now() - startedAt) / 1000,
      buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 150],
    });
    return "completed";
  }

  private async captureImage(job: DocumentProcessingJobRecord, image: CapturableDocumentImage, chunkId: string | null): Promise<CaptureOutcome> {
    const keepStored = async (outcome: CaptureOutcome): Promise<CaptureOutcome> => {
      await this.deps.images.reanchor({ id: image.id, chunkId });
      return outcome;
    };
    const fetched = await this.deps.fetchImage(image.sourceUrl, { ifNoneMatch: image.status === "stored" ? image.sourceEtag : null });
    if (fetched.kind === "not_modified") return keepStored("reused");
    if (fetched.kind === "failed") {
      const outcome = FETCH_FAILURE_OUTCOMES[fetched.reason];
      // A stored copy stays while the content names the image; only new bytes can replace it.
      if (image.status === "stored") return keepStored(outcome);
      return this.refuse(image, outcome);
    }
    const sha256 = createHash("sha256").update(fetched.bytes).digest("hex");
    if (image.status === "stored" && image.sha256 === sha256) return keepStored("reused");
    const encoded = await this.deps.encodeImage(fetched.bytes, { minShortSidePx: MIN_SHORT_SIDE_PX });
    if (encoded.kind === "refused") {
      if (image.status === "stored" && encoded.reason === "busy") return keepStored("busy");
      return this.refuse(image, encoded.reason);
    }
    const renditions: DocumentImageRendition[] = [];
    for (const rendition of encoded.renditions) {
      const stored = await this.deps.storage.upload({
        workspaceId: job.workspaceId,
        documentId: objectLeaf(image.id, rendition.slotWidth),
        folder: "documents",
        filename: "image.webp",
        mimeType: "image/webp",
        buffer: rendition.webp,
      });
      renditions.push({ ...stored, generation: stored.generation ?? null, width: rendition.slotWidth, height: rendition.height });
    }
    const marked = await this.deps.images.markStored({
      id: image.id,
      chunkId,
      width: encoded.width,
      height: encoded.height,
      sha256,
      sourceEtag: fetched.etag ?? null,
      renditions,
    });
    if (!marked) await this.deleteCopies(renditions);
    return "stored";
  }

  /** A refusal that may pass next time leaves the image pending; any other marks it skipped and drops its copies. */
  private async refuse(image: CapturableDocumentImage, outcome: CaptureOutcome): Promise<CaptureOutcome> {
    if (!RETRIED_OUTCOMES.has(outcome)) {
      await this.deleteCopies(await this.deps.images.markSkipped(image.id));
    }
    return outcome;
  }

  /** Best effort: a copy left behind is swept with its workspace. */
  private async deleteCopies(renditions: readonly DocumentImageRendition[]): Promise<void> {
    await Promise.allSettled(renditions.map((rendition) => this.deps.storage.delete({
      bucket: rendition.bucket,
      objectPath: rendition.objectPath,
      generation: rendition.generation,
    })));
  }
}
