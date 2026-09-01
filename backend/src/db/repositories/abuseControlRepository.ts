import { consumeAbuseControlEntry, currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  AbuseControlBatchConsumption,
  AbuseControlConsumption,
  AbuseControlConsumptionInput,
  AbuseControlEntry,
  AbuseControlRepositoryPort,
} from "../../modules/security/contracts/abuseControl.js";

interface AbuseControlEntryRow {
  scope: string;
  subject_key: string;
  attempt_count: number;
  window_started_at: Date;
  blocked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

const abuseControlColumns = [
  "scope",
  "subject_key",
  "attempt_count",
  "window_started_at",
  "blocked_until",
  "created_at",
  "updated_at",
] as const;

const mapEntry = (row: AbuseControlEntryRow): AbuseControlEntry => ({
  scope: row.scope,
  subjectKey: row.subject_key,
  attemptCount: row.attempt_count,
  windowStartedAt: new Date(row.window_started_at),
  blockedUntil: row.blocked_until ? new Date(row.blocked_until) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

class BatchRejectedError extends Error {
  constructor(readonly consumption: AbuseControlConsumption) {
    super("Abuse-control batch rejected");
  }
}

export class AbuseControlRepository implements AbuseControlRepositoryPort {
  constructor(private readonly db: Db) {}

  async find(scope: string, subjectKey: string): Promise<AbuseControlEntry | null> {
    const row = await this.db
      .selectFrom("abuse_control_entries")
      .select(abuseControlColumns)
      .where("scope", "=", scope)
      .where("subject_key", "=", subjectKey)
      .executeTakeFirst();

    return row ? mapEntry(row) : null;
  }

  async save(input: {
    scope: string;
    subjectKey: string;
    attemptCount: number;
    windowStartedAt: Date;
    blockedUntil: Date | null;
  }): Promise<AbuseControlEntry> {
    const row = await this.db
      .insertInto("abuse_control_entries")
      .values({
        scope: input.scope,
        subject_key: input.subjectKey,
        attempt_count: input.attemptCount,
        window_started_at: input.windowStartedAt,
        blocked_until: input.blockedUntil,
      })
      .onConflict((oc) =>
        oc.columns(["scope", "subject_key"]).doUpdateSet((eb) => ({
          attempt_count: eb.ref("excluded.attempt_count"),
          window_started_at: eb.ref("excluded.window_started_at"),
          blocked_until: eb.ref("excluded.blocked_until"),
          updated_at: currentTimestamp(),
        })),
      )
      .returning(abuseControlColumns)
      .executeTakeFirstOrThrow();

    return mapEntry(row);
  }

  async consume(input: AbuseControlConsumptionInput): Promise<AbuseControlConsumption> {
    const result = await consumeAbuseControlEntry(input).execute(this.db);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Atomic abuse-control consumption returned no entry");
    }
    const entry = mapEntry(row);
    return {
      entry,
      blocked: Boolean(entry.blockedUntil && entry.blockedUntil.getTime() > input.now.getTime()),
    };
  }

  async consumeBatch(inputs: readonly AbuseControlConsumptionInput[]): Promise<AbuseControlBatchConsumption> {
    if (inputs.length === 0) {
      return { entries: [], rejected: null };
    }

    try {
      const entries = await this.db.transaction().execute(async (trx) => {
        const repository = new AbuseControlRepository(trx);
        const consumed: AbuseControlConsumption[] = [];
        for (const input of inputs) {
          const result = await repository.consume(input);
          if (result.blocked) {
            throw new BatchRejectedError(result);
          }
          consumed.push(result);
        }
        return consumed;
      });
      return { entries, rejected: null };
    } catch (error) {
      if (error instanceof BatchRejectedError) {
        return { entries: [], rejected: error.consumption };
      }
      throw error;
    }
  }

  async deleteExpired(now: Date): Promise<void> {
    const windowCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await this.db
      .deleteFrom("abuse_control_entries")
      .where((eb) =>
        eb.or([
          eb.and([eb("blocked_until", "is not", null), eb("blocked_until", "<=", now)]),
          eb.and([eb("blocked_until", "is", null), eb("window_started_at", "<=", windowCutoff)]),
        ]),
      )
      .execute();
  }
}
