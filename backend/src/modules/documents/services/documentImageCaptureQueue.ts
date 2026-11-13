import type {
  DocumentProcessingJobRecord,
  DocumentProcessingJobRepositoryPort,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type {
  DocumentImageCandidateWriter,
  DocumentImageCaptureStore,
  PlacedDocumentImage,
} from "../contracts/documentImages.js";
import type { DocumentJobDispatcherPort } from "./documentJobDispatcher.js";

interface QueueDependencies {
  images: DocumentImageCandidateWriter & Pick<DocumentImageCaptureStore, "hasImages">;
  jobs: Pick<DocumentProcessingJobRepositoryPort, "ensureFollowUpJob">;
  dispatcher: DocumentJobDispatcherPort;
  logger?: Pick<AppLogger, "warn">;
}

/** What ingestion hands over: the images a document's content names, placed in its stored text. */
export interface DocumentImageCandidatesPort {
  /**
   * Records them for the document. `published` is true when the revision they belong to already
   * has its chunks (a page whose text did not change), so capture is queued at once rather than
   * after the next vectorize job. Never throws: a document never fails over its images.
   */
  recordCandidates(input: {
    workspaceId: string;
    documentId: string;
    revision: number;
    published: boolean;
    images: readonly PlacedDocumentImage[];
  }): Promise<void>;
}

/**
 * Decides when a document's images are captured: after a revision's chunks are published, when
 * the document names any image, and straight away when an unchanged page names new ones. Capture is
 * the worker's `images` job, a follow-up of the revision like enrichment; a finished one is queued
 * again rather than duplicated.
 */
export class DocumentImageCaptureQueue implements DocumentImageCandidatesPort {
  constructor(private readonly deps: QueueDependencies) {}

  async recordCandidates(input: {
    workspaceId: string;
    documentId: string;
    revision: number;
    published: boolean;
    images: readonly PlacedDocumentImage[];
  }): Promise<void> {
    try {
      const { captureNeeded } = await this.deps.images.recordCandidates(input);
      if (input.published && captureNeeded) {
        await this.queueCapture({ documentId: input.documentId, workspaceId: input.workspaceId, documentRevision: input.revision });
      }
    } catch (error) {
      this.deps.logger?.warn(
        { err: error, workspaceId: input.workspaceId, documentId: input.documentId },
        "Document images could not be recorded; the document goes on without them",
      );
    }
  }

  /** Never throws: the vectorize job that published the revision has already completed. */
  async afterRevisionPublished(job: Pick<DocumentProcessingJobRecord, "documentId" | "workspaceId" | "documentRevision">): Promise<void> {
    try {
      if (await this.deps.images.hasImages(job.documentId)) {
        await this.queueCapture(job);
      }
    } catch (error) {
      this.deps.logger?.warn(
        { err: error, workspaceId: job.workspaceId, documentId: job.documentId },
        "Document image capture could not be queued; the next sync queues it again",
      );
    }
  }

  private async queueCapture(revision: Pick<DocumentProcessingJobRecord, "documentId" | "workspaceId" | "documentRevision">): Promise<void> {
    const job = await this.deps.jobs.ensureFollowUpJob({
      kind: "images",
      documentId: revision.documentId,
      workspaceId: revision.workspaceId,
      documentRevision: revision.documentRevision,
      requeueFinished: true,
    });
    if (job.status !== "queued") return;
    // Task-server deployments run no poll loop, so the job is dispatched; the recovery sweep is the backstop.
    await this.deps.dispatcher.dispatch({
      jobId: job.id,
      documentId: job.documentId,
      workspaceId: job.workspaceId,
      revision: job.documentRevision,
    });
  }
}
