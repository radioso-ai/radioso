import type {
  BackgroundJobClaim,
  BackgroundJobClaimableKind,
  BackgroundJobCompletion,
  BackgroundJobSkipped,
  BackgroundJobStore,
} from "../../shared/background-jobs/index.js";
import { SUBJECT_ACTION_TYPES, subjectActionValues } from "../../modules/chat/contracts/index.js";
import {
  exportTimestamp,
  type DataSubjectDataExporter,
  type DataSubjectExportRecord,
  type DataSubjectExportScope,
} from "../../shared/domain/dataSubjectAccess.js";
import { anyOf, currentTimestamp, nowMinusSeconds, nowPlusSeconds, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export type ActionRequestStatus = "pending" | "in_progress" | "dispatched" | "failed" | "skipped";

/**
 * The outcome of recording a dispatch failure. `superseded` means this worker's claim
 * was already reclaimed by another (its lease expired), so its result was ignored.
 */
export type ActionFailureOutcome = "retry" | "failed" | "superseded";

interface ActionOutboxDepthSnapshot {
  pendingCount: number;
  inProgressCount: number;
  oldestPendingCreatedAt: Date | null;
}

export interface ActionRequestRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  workspaceId: string | null;
  accountId: string | null;
  conversationId: string | null;
  idempotencyKey: string | null;
  status: ActionRequestStatus;
  attempts: number;
  /** The named skill that fired this action, when it was invoked through one (see enqueue). */
  skillName: string | null;
}

export interface EnqueueActionRequestInput {
  type: string;
  payload: Record<string, unknown>;
  workspaceId?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  idempotencyKey?: string | null;
  /**
   * The name of the skill that fired this action, when a routine invoked one by
   * name (e.g. a `notify` skill). Routing provenance, not domain data — kept out
   * of `payload` so a delivery resolver can key off it without parsing payload
   * shape. Actions a routine step emits directly (no named skill) leave this null.
   */
  skillName?: string | null;
}

/**
 * The action outbox: routines enqueue fire-and-forget requests here (transactionally with the
 * turn), and the generic background-job runtime (#1509) drains them through `ActionRequestRepository
 * implements BackgroundJobStore` — see `claimNext` through `deadLetter` below,
 * `backend/src/modules/chat/services/actions/actionDispatchJob.ts` (the job kind and the adapter
 * that routes a claim to the registered `ActionHandler`), and
 * `tests/integration/action-request-repository.integration.test.ts` for the store's own
 * conformance tests. Enqueue is **idempotent** on `idempotencyKey` so a retried turn does not
 * double-emit.
 */
export class ActionRequestRepository implements BackgroundJobStore {
  constructor(private readonly db: Db) {}

  /** Idempotent enqueue; returns the row id (existing one when the key already exists). */
  async enqueue(input: EnqueueActionRequestInput): Promise<{ id: string; duplicate: boolean }> {
    const inserted = await this.db
      .insertInto("routine_action_requests")
      .values({
        type: input.type,
        payload: toJsonb(input.payload ?? {}),
        workspace_id: input.workspaceId ?? null,
        account_id: input.accountId ?? null,
        conversation_id: input.conversationId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        skill_name: input.skillName ?? null,
      })
      .onConflict((oc) => oc.column("idempotency_key").where("idempotency_key", "is not", null).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted) {
      return { id: inserted.id, duplicate: false };
    }
    // Conflict on the idempotency key — return the existing row.
    const existing = await this.db
      .selectFrom("routine_action_requests")
      .select("id")
      .where("idempotency_key", "=", input.idempotencyKey!)
      .executeTakeFirstOrThrow();
    return { id: existing.id, duplicate: true };
  }

  /** The idempotency keys among `keys` whose request is still due or being dispatched. */
  async liveIdempotencyKeys(keys: readonly string[]): Promise<ReadonlySet<string>> {
    if (keys.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom("routine_action_requests")
      .select("idempotency_key")
      .where("idempotency_key", "in", keys)
      .where("status", "in", ["pending", "in_progress"])
      .execute();
    return new Set(rows.flatMap((row) => (row.idempotency_key === null ? [] : [row.idempotency_key])));
  }

  /**
   * A point-in-time read of outbox backlog for observability (not used by the drain
   * path itself). Mirrors `DocumentProcessingJobRepository.getQueueSnapshot()`: counts
   * by state plus the oldest pending row's `created_at`, so an operator can alert on
   * both current depth and how long the oldest item has been waiting. Uses the same
   * `routine_action_requests_claimable_idx` partial index (`created_at WHERE status IN
   * ('pending','in_progress')`) the claim query already relies on.
   */
  async getPendingDepthSnapshot(): Promise<ActionOutboxDepthSnapshot> {
    const row = await this.db
      .selectFrom("routine_action_requests")
      .select((eb) => [
        eb.fn.countAll<number>().filterWhere("status", "=", "pending").as("pending_count"),
        eb.fn.countAll<number>().filterWhere("status", "=", "in_progress").as("in_progress_count"),
        eb.fn.min<Date>("created_at").filterWhere("status", "=", "pending").as("oldest_pending_created_at"),
      ])
      .where("status", "in", ["pending", "in_progress"])
      .executeTakeFirst();

    return {
      pendingCount: Number(row?.pending_count ?? 0),
      inProgressCount: Number(row?.in_progress_count ?? 0),
      oldestPendingCreatedAt: row?.oldest_pending_created_at ? new Date(row.oldest_pending_created_at) : null,
    };
  }

  // ── BackgroundJobStore conformance ────────────────────────────────────
  //
  // This store backs exactly one logical kind for the whole table — every action `type` rides it
  // (see the class doc comment) — so `kinds` exists only so the generic runtime can address this
  // store by a name; the real routing value (the row's own `type`) travels inside the claim's
  // `payload` instead, alongside the routing columns `ActionHandlerContext` needs.
  //
  // The fencing token is this row's `attempts` *after* the claiming increment, stringified —
  // the same value `claimPending`/`markDispatched`/`recordFailure` already fence a stale worker
  // on, just carried through `BackgroundJobClaim.token` instead of a separate parameter. There is
  // no `lease_expires_at` column: a claim's staleness check against `updated_at` (mirroring
  // `claimPending`'s `leaseSeconds` parameter) *is* the lease, so `renewLease` only has to refresh
  // that column.

  /**
   * Due is decided by Postgres's own `now()`, never a caller-supplied instant — mirrors
   * `BackgroundJobRepository.claimNext` (#1535). `excludeIds` (the ids a single `drain()` call has
   * already claimed) is a `NOT IN`, so a row due by this same `now()` is still skipped when the
   * caller has already claimed it this call — the same same-drain reclaim guard the generic store
   * provides, so a retry scheduled mid-drain with a short delay waits for the next wake or sweep
   * instead of being reclaimed inside the same drain that just retried it.
   */
  async claimNext(input: {
    kinds: readonly BackgroundJobClaimableKind[];
    excludeIds?: readonly string[];
  }): Promise<BackgroundJobClaim | null> {
    if (input.kinds.length === 0) {
      return null;
    }
    const kind = input.kinds[0].kind;
    const leaseSeconds = Math.min(...input.kinds.map((entry) => entry.leaseSeconds));
    return this.db.transaction().execute(async (trx) => {
      let query = trx
        .selectFrom("routine_action_requests")
        .select(["id", "next_attempt_at", "created_at"])
        .where((eb) =>
          eb.or([
            eb.and([
              eb("status", "=", "pending"),
              eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", currentTimestamp())]),
            ]),
            eb.and([eb("status", "=", "in_progress"), eb("updated_at", "<", nowMinusSeconds(leaseSeconds))]),
          ]),
        );
      if (input.excludeIds && input.excludeIds.length > 0) {
        query = query.where("id", "not in", [...input.excludeIds]);
      }
      const due = await query.orderBy("created_at", "asc").limit(1).forUpdate().skipLocked().executeTakeFirst();
      if (!due) {
        return null;
      }
      const claimed = await trx
        .updateTable("routine_action_requests")
        .set((eb) => ({ status: "in_progress", attempts: eb("attempts", "+", 1), updated_at: currentTimestamp() }))
        .where("id", "=", due.id)
        .returning(jobClaimColumns)
        .executeTakeFirstOrThrow();
      return mapJobClaim(claimed as JobClaimRow, due.next_attempt_at ?? due.created_at, kind);
    });
  }

  // `leaseSeconds` is accepted for interface parity but unused: the next `claimNext` call applies
  // its own `kinds[].leaseSeconds` when it re-evaluates staleness, so renewing is just "I am still
  // alive now" — the lease's *size* is re-applied at claim time, not stored on this row.
  async renewLease(claim: BackgroundJobClaim, _input: { leaseSeconds: number }): Promise<boolean> {
    const result = await this.db
      .updateTable("routine_action_requests")
      .set({ updated_at: currentTimestamp() })
      .where("id", "=", claim.id)
      .where("attempts", "=", Number(claim.token))
      .where("status", "=", "in_progress")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Marks the row `dispatched`. Unlike the generic store's `complete`, nothing is deleted — a
   * dispatched row stays readable the same way a `failed` one does (operator visibility,
   * `liveIdempotencyKeys`) — so "deleted" below means "no longer live," not a row removal.
   * `outcome` carries the handler's skip reason, when there is one: this table has its own
   * terminal `skipped` state (unlike the generic store, which just completes it as usual), so
   * the row lands there instead of `dispatched`.
   */
  async complete(claim: BackgroundJobClaim, outcome?: BackgroundJobSkipped): Promise<BackgroundJobCompletion> {
    const result = await this.db
      .updateTable("routine_action_requests")
      .set(
        outcome
          ? { status: "skipped", last_error: outcome.skipped, updated_at: currentTimestamp() }
          : { status: "dispatched", updated_at: currentTimestamp() },
      )
      .where("id", "=", claim.id)
      .where("attempts", "=", Number(claim.token))
      .where("status", "=", "in_progress")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0 ? "deleted" : "superseded";
  }

  /**
   * A rerun requested during this run is covered by the retry, which reads state when it runs.
   * `onRetried` runs in the same transaction once the reschedule actually lands, mirroring
   * `deadLetter`'s `onParked`: a hook that throws rolls back the reschedule along with it.
   */
  async retry(
    claim: BackgroundJobClaim,
    input: { error: string; delaySeconds: number },
    onRetried?: (transaction: Db) => Promise<void>,
  ): Promise<Date | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("routine_action_requests")
        .set({
          status: "pending",
          next_attempt_at: nowPlusSeconds(input.delaySeconds),
          last_error: input.error,
          updated_at: currentTimestamp(),
        })
        .where("id", "=", claim.id)
        .where("attempts", "=", Number(claim.token))
        .where("status", "=", "in_progress")
        .returning("next_attempt_at")
        .executeTakeFirst();
      if (!row?.next_attempt_at) {
        return null;
      }
      await onRetried?.(trx);
      return new Date(row.next_attempt_at);
    });
  }

  /**
   * Marks the row terminally `failed`. Unlike the generic store's `deadLetter`, the payload is
   * kept — this table's existing contract (see `recordFailure`) is that a terminal failure stays
   * readable for operator visibility, exactly as today.
   */
  async deadLetter(
    claim: BackgroundJobClaim,
    input: { error: string },
    onParked?: (transaction: Db) => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable("routine_action_requests")
        .set({ status: "failed", last_error: input.error, updated_at: currentTimestamp() })
        .where("id", "=", claim.id)
        .where("attempts", "=", Number(claim.token))
        .where("status", "=", "in_progress")
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return false;
      }
      await onParked?.(trx);
      return true;
    });
  }
}

interface JobClaimRow {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  workspace_id: string | null;
  account_id: string | null;
  conversation_id: string | null;
  idempotency_key: string | null;
  skill_name: string | null;
  attempts: number;
}

const jobClaimColumns = [
  "id",
  "type",
  "payload",
  "workspace_id",
  "account_id",
  "conversation_id",
  "idempotency_key",
  "skill_name",
  "attempts",
] as const;

/**
 * The generic port's `payload` is an opaque per-kind blob; this table has no `kind` column, only
 * `type` (one logical kind rides every type — see the class doc comment), so the claim's payload
 * carries `type` alongside the row's own `payload` and the routing columns
 * `ActionHandlerContext` needs, since the generic port has nowhere else to put them. The job-kind
 * handler adapter (`actionDispatchJob.ts`) is the only reader.
 */
export interface ActionDispatchJobPayload {
  type: string;
  payload: Record<string, unknown>;
  workspaceId: string | null;
  accountId: string | null;
  conversationId: string | null;
  idempotencyKey: string | null;
  skillName: string | null;
}

const mapJobClaim = (row: JobClaimRow, availableAt: Date, kind: string): BackgroundJobClaim => ({
  id: row.id,
  kind,
  payload: {
    type: row.type,
    payload: row.payload ?? {},
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    skillName: row.skill_name,
  } satisfies ActionDispatchJobPayload,
  attempt: row.attempts,
  idempotencyKey: row.idempotency_key,
  token: String(row.attempts),
  availableAt: new Date(availableAt),
});


/**
 * The export's `routine_actions` section: what a conversation's routines handed on about the person,
 * such as a contact request or the values a routine's ending carried to the team or to a webhook.
 * It outlives the routine state the values came from. Only the action types that carry the
 * person's own values are exported, each reduced to them (`subjectActionValues`).
 */
export class ActionRequestExporter implements DataSubjectDataExporter {
  readonly section = "routine_actions";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    if (scope.conversationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("routine_action_requests")
      .select(["conversation_id", "type", "payload", "created_at"])
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("conversation_id"), scope.conversationIds, "uuid[]"))
      .where((eb) => anyOf(eb.ref("type"), SUBJECT_ACTION_TYPES, "text[]"))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.flatMap((row) => {
      const projected = subjectActionValues(row.type, row.payload);
      return projected ? [{
        conversationId: row.conversation_id,
        type: row.type,
        routineId: projected.routineId,
        values: projected.values,
        createdAt: exportTimestamp(row.created_at),
      }] : [];
    });
  }
}
