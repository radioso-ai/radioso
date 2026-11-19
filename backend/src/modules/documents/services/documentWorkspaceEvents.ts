import type { DocumentEventDraft } from "../../../shared/domain/workspaceEventLog.js";
import type { DocumentProcessingJobRecord } from "../../../db/repositories/documentProcessingJobRepository.js";

type RevisionJob = Pick<DocumentProcessingJobRecord, "workspaceId" | "documentId" | "documentRevision">;

/**
 * A revision's vectorize job completed: the document serves retrieval at that revision. One per
 * revision, however many runs reach the completion.
 */
export const documentProcessedEvent = (job: RevisionJob): DocumentEventDraft => ({
  type: "document.processed",
  workspaceId: job.workspaceId,
  documentId: job.documentId,
  revision: job.documentRevision,
  idempotencyKey: `document.processed:${job.documentId}:${job.documentRevision}`,
  detail: {},
});

/**
 * A revision's vectorize job failed for good, and the document with it. Carries the failure's code
 * only: its message can quote provider responses or document text.
 */
export const documentFailedEvent = (job: RevisionJob, failureCode: string | null): DocumentEventDraft => ({
  type: "document.failed",
  workspaceId: job.workspaceId,
  documentId: job.documentId,
  revision: job.documentRevision,
  idempotencyKey: `document.failed:${job.documentId}:${job.documentRevision}`,
  detail: { failureCode },
});
