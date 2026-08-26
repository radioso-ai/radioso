import type {
  FacetExtractionEnqueueResult,
  FacetExtractionJob,
  FacetExtractionJobClaim,
  FacetExtractionJobStatus,
  FacetExtractionJobStore,
} from "../../modules/facets/contracts.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface FacetExtractionJobRow {
  id: string;
  message_id: string;
  workspace_id: string;
  status: string;
  attempt_count: number;
  claimed_at: Date | null;
  scheduled_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const facetExtractionJobColumns = [
  "id",
  "message_id",
  "workspace_id",
  "status",
  "attempt_count",
  "claimed_at",
  "scheduled_at",
  "last_error",
  "created_at",
  "updated_at",
] as const;

const mapJob = (row: FacetExtractionJobRow): FacetExtractionJob => ({
  id: row.id,
  messageId: row.message_id,
  workspaceId: row.workspace_id,
  status: row.status as FacetExtractionJobStatus,
  attemptCount: Number(row.attempt_count),
  claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
  scheduledAt: new Date(row.scheduled_at),
  lastError: row.last_error,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const changedRows = (result: { numUpdatedRows: bigint | number }): number =>
  Number(result.numUpdatedRows);

/**
 * Postgres implementation of the facet extraction job spine.
 *
 * Constructed with a `Db`, so the same repository runs on the shared pool or inside a
 * caller's transaction.
 */
export class FacetExtractionJobRepository implements FacetExtractionJobStore {
  constructor(private readonly db: Db) {}

  /**
   * Idempotent on the `message_id` unique constraint. A conflict means the message
   * already has a job — including one that already completed, failed, or was skipped —
   * so the existing row is returned untouched rather than restarted.
   */
  async enqueue(input: {
    messageId: string;
    workspaceId: string;
    restartTerminal?: boolean;
  }): Promise<FacetExtractionEnqueueResult> {
    const inserted = await this.db
      .insertInto("facet_extraction_jobs")
      .values({
        message_id: input.messageId,
        workspace_id: input.workspaceId,
        status: "queued",
      })
      .onConflict((oc) => oc.column("message_id").doNothing())
      .returning("id")
      .executeTakeFirst();

    if (inserted) {
      return { id: inserted.id, created: true };
    }

    const existing = await this.db
      .selectFrom("facet_extraction_jobs")
      .select(["id", "status"])
      .where("message_id", "=", input.messageId)
      .executeTakeFirstOrThrow();

    if (input.restartTerminal && ["completed", "failed", "skipped"].includes(existing.status)) {
      await this.db
        .updateTable("facet_extraction_jobs")
        .set({
          workspace_id: input.workspaceId,
          status: "queued",
          attempt_count: 0,
          claimed_at: null,
          scheduled_at: currentTimestamp(),
          last_error: null,
          updated_at: currentTimestamp(),
        })
        .where("id", "=", existing.id)
        .execute();
    }

    return { id: existing.id, created: false };
  }

  /**
   * One statement: the `due` CTE takes row locks with `SKIP LOCKED`, so a concurrent
   * worker's select never sees the rows this claim is taking and the two claims are
   * disjoint.
   *
   * The locking select MUST live in a CTE rather than an `id IN (SELECT ... LIMIT n
   * FOR UPDATE SKIP LOCKED)` subquery. Postgres can plan that subquery form as a nested
   * loop semi join, which re-executes the locking select — LIMIT included — once per
   * candidate outer row and claims far more than `limit` rows. Whether it does depends on
   * table statistics, so the subquery form passes on an empty table and breaks later. A
   * `FOR UPDATE` CTE is never inlined, so it is evaluated exactly once and the limit holds.
   */
  async claimBatch(
    limit: number,
    now: Date = new Date(),
    workspaceId?: string,
    messageWindow?: { start: Date; end: Date },
  ): Promise<FacetExtractionJob[]> {
    const rows = await this.db
      .with("due", (qb) =>
        qb
          .selectFrom("facet_extraction_jobs")
          // Qualified: the windowed drain joins `messages`, which also has an `id`.
          .select("facet_extraction_jobs.id")
          .where("facet_extraction_jobs.status", "=", "queued")
          .where("facet_extraction_jobs.scheduled_at", "<=", now)
          .$if(workspaceId !== undefined, (query) => query.where("facet_extraction_jobs.workspace_id", "=", workspaceId!))
          .$if(messageWindow !== undefined, (query) => query
            .innerJoin("messages as facet_source_message", "facet_source_message.id", "facet_extraction_jobs.message_id")
            .where("facet_source_message.created_at", ">=", messageWindow!.start)
            .where("facet_source_message.created_at", "<", messageWindow!.end))
          .orderBy("facet_extraction_jobs.scheduled_at", "asc")
          .orderBy("facet_extraction_jobs.created_at", "asc")
          .limit(limit)
          .forUpdate()
          .skipLocked(),
      )
      .updateTable("facet_extraction_jobs")
      .from("due")
      .set((eb) => ({
        status: "processing",
        attempt_count: eb("facet_extraction_jobs.attempt_count", "+", 1),
        claimed_at: now,
        updated_at: now,
      }))
      .whereRef("facet_extraction_jobs.id", "=", "due.id")
      .returning(facetExtractionJobColumns.map((column) => `facet_extraction_jobs.${column}` as const))
      .execute();

    return rows.map((row) => mapJob(row as FacetExtractionJobRow));
  }

  async nextWorkspaceScheduledAt(workspaceId: string, messageWindow?: { start: Date; end: Date }): Promise<Date | null> {
    const row = await this.db
      .selectFrom("facet_extraction_jobs")
      .$if(messageWindow !== undefined, (query) => query
        .innerJoin("messages as facet_source_message", "facet_source_message.id", "facet_extraction_jobs.message_id")
        .where("facet_source_message.created_at", ">=", messageWindow!.start)
        .where("facet_source_message.created_at", "<", messageWindow!.end))
      .select((eb) => eb.fn.min<Date>("facet_extraction_jobs.scheduled_at").as("scheduled_at"))
      .where("facet_extraction_jobs.workspace_id", "=", workspaceId)
      .where("facet_extraction_jobs.status", "=", "queued")
      .executeTakeFirst();
    return row?.scheduled_at ? new Date(row.scheduled_at) : null;
  }

  async hasPendingWorkspaceWork(workspaceId: string, messageWindow?: { start: Date; end: Date }): Promise<boolean> {
    const row = await this.db
      .selectFrom("facet_extraction_jobs")
      .$if(messageWindow !== undefined, (query) => query
        .innerJoin("messages as facet_source_message", "facet_source_message.id", "facet_extraction_jobs.message_id")
        .where("facet_source_message.created_at", ">=", messageWindow!.start)
        .where("facet_source_message.created_at", "<", messageWindow!.end))
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("facet_extraction_jobs.workspace_id", "=", workspaceId)
      .where("facet_extraction_jobs.status", "in", ["queued", "processing"])
      .executeTakeFirst();
    return Number(row?.count ?? 0) > 0;
  }

  async markCompleted(job: FacetExtractionJobClaim): Promise<boolean> {
    if (job.claimedAt === null) return false;
    const result = await this.db
      .updateTable("facet_extraction_jobs")
      .set({
        status: "completed",
        claimed_at: null,
        last_error: null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", job.id)
      .where("status", "=", "processing")
      .where("attempt_count", "=", job.attemptCount)
      .where("claimed_at", "=", job.claimedAt)
      .executeTakeFirst();
    return changedRows(result) > 0;
  }

  async markSkipped(job: FacetExtractionJobClaim, reason: string): Promise<boolean> {
    if (job.claimedAt === null) return false;
    const result = await this.db
      .updateTable("facet_extraction_jobs")
      .set({
        status: "skipped",
        last_error: reason,
        claimed_at: null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", job.id)
      .where("status", "=", "processing")
      .where("attempt_count", "=", job.attemptCount)
      .where("claimed_at", "=", job.claimedAt)
      .executeTakeFirst();
    return changedRows(result) > 0;
  }

  async markFailed(job: FacetExtractionJobClaim, error: string, nextScheduledAt: Date | null): Promise<boolean> {
    if (job.claimedAt === null) return false;
    const result = await this.db
      .updateTable("facet_extraction_jobs")
      .set({
        status: nextScheduledAt ? "queued" : "failed",
        last_error: error,
        ...(nextScheduledAt ? { scheduled_at: nextScheduledAt } : {}),
        claimed_at: null,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", job.id)
      .where("status", "=", "processing")
      .where("attempt_count", "=", job.attemptCount)
      .where("claimed_at", "=", job.claimedAt)
      .executeTakeFirst();
    return changedRows(result) > 0;
  }

  /**
   * The attempt was already counted at claim time, so a released job resumes with its
   * remaining budget and a worker crash loop cannot retry forever.
   */
  async releaseExpiredClaims(input: { claimedAtOrBefore: Date; maxAttempts: number; workspaceId?: string }): Promise<number> {
    const failed = await this.db
      .updateTable("facet_extraction_jobs")
      .set({
        status: "failed",
        claimed_at: null,
        last_error: "claim_expired",
        updated_at: currentTimestamp(),
      })
      .where("status", "=", "processing")
      .where("claimed_at", "is not", null)
      .where("claimed_at", "<=", input.claimedAtOrBefore)
      .where("attempt_count", ">=", input.maxAttempts)
      .$if(input.workspaceId !== undefined, (query) => query.where("workspace_id", "=", input.workspaceId!))
      .executeTakeFirst();

    const released = await this.db
      .updateTable("facet_extraction_jobs")
      .set({
        status: "queued",
        claimed_at: null,
        scheduled_at: currentTimestamp(),
        last_error: "claim_expired",
        updated_at: currentTimestamp(),
      })
      .where("status", "=", "processing")
      .where("claimed_at", "is not", null)
      .where("claimed_at", "<=", input.claimedAtOrBefore)
      .where("attempt_count", "<", input.maxAttempts)
      .$if(input.workspaceId !== undefined, (query) => query.where("workspace_id", "=", input.workspaceId!))
      .executeTakeFirst();

    return changedRows(failed) + changedRows(released);
  }
}
