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
import type { ChunkRepositoryPort } from "../../modules/documents/contracts/index.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

/**
 * Document image capture wiring: ingestion records the images a document's content names, the
 * document worker captures them through the public fetch and the shared image codec into document
 * storage, and sweeps the copies of images whose document is gone.
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
}): { candidates: DocumentImageCandidatesPort; stage: DocumentImageCaptureStage } => {
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
  };
};
