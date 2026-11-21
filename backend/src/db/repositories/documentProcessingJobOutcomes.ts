import type { DocumentEventDraft, WorkspaceEventRecorder } from "../../shared/domain/workspaceEventLog.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { DocumentProcessingJobRecord } from "./documentProcessingJobRows.js";

/** The run a terminal write speaks for: the job, and the attempt its claim took. */
export type DocumentProcessingJobClaim = Pick<DocumentProcessingJobRecord, "id" | "attemptCount">;

/**
 * How a document processing job ends: completed, skipped or failed. Every write is fenced on the
 * caller's claim: `status = 'processing'` and the attempt it claimed. A late-finishing run never
 * overwrites a terminal state another caller already committed (a recovery sweep's own terminal
 * write, or a second completion attempt), and a run that lost its lease never ends the job another
 * run has claimed since; every claim takes the next attempt.
 *
 * A completion or failure the caller names a document event for records it in the same
 * transaction, and only when the fence hits: one run's terminal write, never a late one's.
 */
export class DocumentProcessingJobOutcomes {
  constructor(
    private readonly db: Db,
    private readonly events: WorkspaceEventRecorder,
  ) {}

  async markCompleted(claim: DocumentProcessingJobClaim, event?: DocumentEventDraft): Promise<boolean> {
    if (!event) return this.complete(this.db, claim);
    return this.inTransaction(async (db) => {
      const completed = await this.complete(db, claim);
      if (completed) await this.events.record(db, event);
      return completed;
    });
  }

  private async complete(db: Db, claim: DocumentProcessingJobClaim): Promise<boolean> {
    const row = await db
      .updateTable("document_processing_jobs")
      .set({
        status: "completed",
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", claim.id)
      .where("status", "=", "processing")
      .where("attempt_count", "=", claim.attemptCount)
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  async markSkipped(claim: DocumentProcessingJobClaim, reason: string): Promise<void> {
    await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "skipped",
        last_error: reason,
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", claim.id)
      // A late-finishing run that already resolved this job some other way
      // (most commonly a legitimate completion racing a recovery sweep's
      // terminal write) must not be overwritten.
      .where("status", "=", "processing")
      .where("attempt_count", "=", claim.attemptCount)
      .execute();
  }

  async markFailed(claim: DocumentProcessingJobClaim, errorMessage: string, errorCode: string | null = null): Promise<boolean> {
    const row = await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "failed",
        last_error: errorMessage,
        last_error_code: errorCode,
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", claim.id)
      // See markSkipped — the same race applies here.
      .where("status", "=", "processing")
      .where("attempt_count", "=", claim.attemptCount)
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  async markFailedIfDocumentMatches(input: {
    claim: DocumentProcessingJobClaim;
    documentId: string;
    workspaceId: string;
    revision: number;
    errorMessage: string;
    errorCode?: string | null;
    /** The document event the failure records, beside the document it fails. */
    event: DocumentEventDraft;
  }): Promise<boolean> {
    return this.inTransaction(async (trx) => {
      // Lock the job row and confirm it is still ours to fail before writing
      // anything. A run that was not actually dead can complete the job
      // between the caller's exhausted decision and this call, and a run
      // that lost its lease finds another claim on it — either way this
      // matches no row, so we return without touching the document at all;
      // the document update below only ever runs once we know the job is
      // still "processing" under this claim.
      const jobRow = await trx
        .selectFrom("document_processing_jobs")
        .select("id")
        .where("id", "=", input.claim.id)
        .where("status", "=", "processing")
        .where("attempt_count", "=", input.claim.attemptCount)
        .forUpdate()
        .executeTakeFirst();

      if (!jobRow) {
        return false;
      }

      const document = await trx
        .updateTable("documents")
        .set({
          status: "failed",
          failed_at: currentTimestamp(),
          failure_reason: input.errorMessage,
          updated_at: currentTimestamp(),
        })
        .where("id", "=", input.documentId)
        .where("workspace_id", "=", input.workspaceId)
        .where("revision", "=", input.revision)
        .returning("id")
        .executeTakeFirst();

      if (!document) {
        // Stale revision or deleted: the job is still processing, but this
        // is not the document to fail. Leave the job untouched — the
        // caller's own fallback (markSkipped) resolves it instead.
        return false;
      }

      await trx
        .updateTable("document_processing_jobs")
        .set({
          status: "failed",
          last_error: input.errorMessage,
          last_error_code: input.errorCode ?? null,
          completed_at: currentTimestamp(),
          updated_at: currentTimestamp(),
        })
        .where("id", "=", input.claim.id)
        .execute();
      await this.events.record(trx, input.event);

      return true;
    });
  }

  private inTransaction<T>(work: (db: Db) => Promise<T>): Promise<T> {
    return this.db.isTransaction ? work(this.db) : this.db.transaction().execute(work);
  }
}
