import type { Database } from "../../shared/infra/database.js";

export interface AbuseControlEntry {
  scope: string;
  subjectKey: string;
  attemptCount: number;
  windowStartedAt: Date;
  blockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AbuseControlEntryRow {
  scope: string;
  subject_key: string;
  attempt_count: number;
  window_started_at: Date;
  blocked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

const mapEntry = (row: AbuseControlEntryRow): AbuseControlEntry => ({
  scope: row.scope,
  subjectKey: row.subject_key,
  attemptCount: row.attempt_count,
  windowStartedAt: new Date(row.window_started_at),
  blockedUntil: row.blocked_until ? new Date(row.blocked_until) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface AbuseControlRepositoryPort {
  find(scope: string, subjectKey: string): Promise<AbuseControlEntry | null>;
  save(input: {
    scope: string;
    subjectKey: string;
    attemptCount: number;
    windowStartedAt: Date;
    blockedUntil: Date | null;
  }): Promise<AbuseControlEntry>;
  deleteExpired(now: Date): Promise<void>;
}

export class AbuseControlRepository implements AbuseControlRepositoryPort {
  constructor(private readonly database: Database) {}

  async find(scope: string, subjectKey: string): Promise<AbuseControlEntry | null> {
    const [row] = await this.database.query<AbuseControlEntryRow>(
      `SELECT scope, subject_key, attempt_count, window_started_at, blocked_until, created_at, updated_at
       FROM abuse_control_entries
       WHERE scope = $1 AND subject_key = $2`,
      [scope, subjectKey],
    );

    return row ? mapEntry(row) : null;
  }

  async save(input: {
    scope: string;
    subjectKey: string;
    attemptCount: number;
    windowStartedAt: Date;
    blockedUntil: Date | null;
  }): Promise<AbuseControlEntry> {
    const [row] = await this.database.query<AbuseControlEntryRow>(
      `INSERT INTO abuse_control_entries (scope, subject_key, attempt_count, window_started_at, blocked_until)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, subject_key)
       DO UPDATE SET attempt_count = EXCLUDED.attempt_count,
                     window_started_at = EXCLUDED.window_started_at,
                     blocked_until = EXCLUDED.blocked_until,
                     updated_at = NOW()
       RETURNING scope, subject_key, attempt_count, window_started_at, blocked_until, created_at, updated_at`,
      [input.scope, input.subjectKey, input.attemptCount, input.windowStartedAt, input.blockedUntil],
    );

    return mapEntry(row);
  }

  async deleteExpired(now: Date): Promise<void> {
    await this.database.query(
      `DELETE FROM abuse_control_entries
       WHERE (blocked_until IS NOT NULL AND blocked_until <= $1)
          OR (blocked_until IS NULL AND window_started_at <= $2)`,
      [now, new Date(now.getTime() - 24 * 60 * 60 * 1000)],
    );
  }
}
