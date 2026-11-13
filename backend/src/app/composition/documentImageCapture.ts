import type { DocumentProcessingJobRepositoryPort } from "../../db/repositories/documentProcessingJobRepository.js";
import {
  DocumentImageCaptureQueue,
  DocumentImageCaptureService,
  encodeDocumentImage,
  fetchDocumentImage,
  type DocumentImageCaptureStage,
  type DocumentImageCandidatesPort,
  type DocumentImageRepository,
  type DocumentJobDispatcherPort,
  type DocumentStoragePort,
} from "../../modules/documents/composition.js";
import type { ChunkRepositoryPort, DocumentImageListing, DocumentImageRows } from "../../modules/documents/contracts/index.js";
import { isSiteBanner, PRIMARY_DOCUMENT_COUNT_LIMIT } from "../../modules/retrieval/public.js";
import type { ReplyImageUrls } from "../../modules/chat/contracts/index.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

/**
 * Document image capture wiring: ingestion records the images a document's content names, the
 * document worker captures them through the public fetch and the shared image codec into document
 * storage, and sweeps the copies of images whose document is gone. A document's detail lists its
 * images with the address the public image route serves each stored copy at.
 */
export const createDocumentImageCapture = (input: {
  images: DocumentImageRepository;
  documents: { findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<{ revision: number; metadata?: Record<string, unknown> | null } | null> };
  chunks: Pick<ChunkRepositoryPort, "listSummariesForDocument">;
  jobs: Pick<DocumentProcessingJobRepositoryPort, "ensureFollowUpJob">;
  dispatcher: DocumentJobDispatcherPort;
  storage: DocumentStoragePort;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  logger: Pick<AppLogger, "warn">;
  /** Where the public image route serves a stored copy, so a document's detail can show it. */
  imageUrls: ReplyImageUrls;
}): { candidates: DocumentImageCandidatesPort; stage: DocumentImageCaptureStage; listing: DocumentImageListing } => {
  const queue = new DocumentImageCaptureQueue({
    images: input.images,
    jobs: input.jobs,
    dispatcher: input.dispatcher,
    logger: input.logger,
  });
  const capture = new DocumentImageCaptureService({
    images: input.images,
    documents: input.documents,
    chunks: input.chunks,
    storage: input.storage,
    fetchImage: fetchDocumentImage,
    encodeImage: encodeDocumentImage,
    metrics: input.metrics,
    logger: input.logger,
  });
  // Closures, not the instances' methods: a consumer holding one as a value cannot lose its receiver.
  return {
    candidates: { recordCandidates: (candidate) => queue.recordCandidates(candidate) },
    stage: {
      capture: (job) => capture.capture(job),
      afterRevisionPublished: (job) => queue.afterRevisionPublished(job),
      sweepReleased: () => capture.sweepReleased(),
    },
    listing: addressedDocumentImageListing(input.images, input.imageUrls),
  };
};

/**
 * A document's images, each stored one with the address the public image route serves its copy at,
 * and each main picture judged by retrieval's site-banner rule, as an answer would judge it.
 */
export const addressedDocumentImageListing = (
  rows: DocumentImageRows,
  imageUrls: ReplyImageUrls,
): DocumentImageListing => ({
  listForDocument: async (document) => {
    const images = await rows.listForDocument({ ...document, primaryDocumentCountLimit: PRIMARY_DOCUMENT_COUNT_LIMIT });
    return images.map(({ primaryDocumentCount, ...image }) => ({
      ...image,
      siteWide: image.status === "stored" && isSiteBanner({ role: image.role, primaryDocumentCount }),
      ...(image.status === "stored" ? imageUrls.forImage(image.id) : {}),
    }));
  },
});
