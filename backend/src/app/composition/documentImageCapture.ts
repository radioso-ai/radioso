import type { DocumentProcessingJobRepositoryPort } from "../../db/repositories/documentProcessingJobRepository.js";
import {
  DocumentImageCaptureQueue,
  DocumentImageCaptureService,
  encodeDocumentImage,
  fetchDocumentImage,
  UploadedFileImages,
  type DocumentImageCaptureStage,
  type DocumentImageCandidatesPort,
  type DocumentImageRepository,
  type DocumentJobDispatcherPort,
  type DocumentStoragePort,
  type UploadedDocumentFile,
} from "../../modules/documents/composition.js";
import type { ChunkRepositoryPort, DocumentImageListing, DocumentImageRows } from "../../modules/documents/contracts/index.js";
import { isSiteBanner, SHARED_DOCUMENT_COUNT_LIMIT } from "../../modules/retrieval/public.js";
import type { ReplyImageUrls } from "../../modules/chat/contracts/index.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

/**
 * Document image capture wiring: ingestion records the images a document's content names, the
 * document worker reads the pictures an uploaded file carries from the stored file, captures them
 * all through the public fetch (or the file's own bytes) and the shared image codec into document
 * storage, and sweeps the copies of images whose document is gone. A document's detail lists its
 * images with the address the public image route serves each stored copy at.
 */
export const createDocumentImageCapture = (input: {
  images: DocumentImageRepository;
  documents: {
    findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<(UploadedDocumentFile & { revision: number; metadata?: Record<string, unknown> | null }) | null>;
  };
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
    documents: input.documents,
    logger: input.logger,
  });
  const capture = new DocumentImageCaptureService({
    images: input.images,
    documents: input.documents,
    chunks: input.chunks,
    storage: input.storage,
    fetchImage: fetchDocumentImage,
    encodeImage: encodeDocumentImage,
    uploadedFiles: new UploadedFileImages({ storage: input.storage, images: input.images, logger: input.logger }),
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
 * and each picture judged by retrieval's site-banner rule, as an answer would judge it.
 */
export const addressedDocumentImageListing = (
  rows: DocumentImageRows,
  imageUrls: ReplyImageUrls,
): DocumentImageListing => ({
  listForDocument: async (document) => {
    const images = await rows.listForDocument({ ...document, sharedDocumentCountLimit: SHARED_DOCUMENT_COUNT_LIMIT });
    return images.map(({ sharedDocumentCount, ...image }) => ({
      ...image,
      siteWide: image.status === "stored" && isSiteBanner({ sharedDocumentCount }),
      ...(image.status === "stored" ? imageUrls.forImage(image.id) : {}),
    }));
  },
});
