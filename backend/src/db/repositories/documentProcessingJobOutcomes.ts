import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * How a document processing job ends: completed, skipped or failed. Every write is fenced on
 * `status = 'processing'`, so a late-finishing run never overwrites a terminal state another caller
 * already committed (a recovery sweep's own terminal write, or a second completion attempt).
 */
export class DocumentProcessingJobOutcomes {
  constructor(private readonly db: Db) {}

  async markCompleted(jobId: string): Promise<boolean> {
    const row = await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "completed",
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      .where("status", "=", "processing")
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  async markSkipped(jobId: string, reason: string): Promise<void> {
    await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "skipped",
        last_error: reason,
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      // A late-finishing run that already resolved this job some other way
      // (most commonly a legitimate completion racing a recovery sweep's
      // terminal write) must not be overwritten.
      .where("status", "=", "processing")
      .execute();
  }

  async markFailed(jobId: string, errorMessage: string, errorCode: string | null = null): Promise<boolean> {
    const row = await this.db
      .updateTable("document_processing_jobs")
      .set({
        status: "failed",
        last_error: errorMessage,
        last_error_code: errorCode,
        completed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", jobId)
      // See markSkipped — the same race applies here.
      .where("status", "=", "processing")
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  async markFailedIfDocumentMatches(input: {
    jobId: string;
    documentId: string;
    workspaceId: string;
    revision: number;
    errorMessage: string;
    errorCode?: string | null;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // Lock the job row and confirm it is still ours to fail before writing
      // anything. A run that was not actually dead can complete the job
      // between the caller's exhausted decision and this call — if it
      // already has, this job update matches no row, so we return without
      // touching the document at all; the document update below only ever
      // runs once we know the job is still "processing".
      const jobRow = await trx
        .selectFrom("document_processing_jobs")
        .select("id")
        .where("id", "=", input.jobId)
        .where("status", "=", "processing")
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
        .where("id", "=", input.jobId)
        .execute();

      return true;
    });
  }
}
