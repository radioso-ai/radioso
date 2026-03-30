import { describe, expect, it } from "vitest";

import { AbuseControlRepository } from "../../src/db/repositories/abuseControlRepository.js";

describe("AbuseControlRepository", () => {
  it("reads, upserts, and expires abuse-control entries", async () => {
    const rows = new Map<string, {
      scope: string;
      subject_key: string;
      attempt_count: number;
      window_started_at: Date;
      blocked_until: Date | null;
      created_at: Date;
      updated_at: Date;
    }>();

    const repository = new AbuseControlRepository({
      query: async <T>(sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();

        if (normalized.startsWith("SELECT scope, subject_key, attempt_count")) {
          const [scope, subjectKey] = params as [string, string];
          const row = rows.get(`${scope}:${subjectKey}`);
          return row ? [row as T] : [];
        }

        if (normalized.startsWith("INSERT INTO abuse_control_entries")) {
          const [scope, subjectKey, attemptCount, windowStartedAt, blockedUntil] = params as [
            string,
            string,
            number,
            Date,
            Date | null,
          ];
          const key = `${scope}:${subjectKey}`;
          const existing = rows.get(key);
          const row = {
            scope,
            subject_key: subjectKey,
            attempt_count: attemptCount,
            window_started_at: windowStartedAt,
            blocked_until: blockedUntil,
            created_at: existing?.created_at ?? new Date("2026-03-30T10:00:00.000Z"),
            updated_at: new Date("2026-03-30T10:05:00.000Z"),
          };
          rows.set(key, row);
          return [row as T];
        }

        if (normalized.startsWith("DELETE FROM abuse_control_entries")) {
          const [now, staleWindowCutoff] = params as [Date, Date];
          for (const [key, row] of rows.entries()) {
            if ((row.blocked_until && row.blocked_until <= now) || (!row.blocked_until && row.window_started_at <= staleWindowCutoff)) {
              rows.delete(key);
            }
          }
          return [];
        }

        throw new Error(`Unexpected SQL in test fake: ${normalized}`);
      },
    } as any);

    const saved = await repository.save({
      scope: "auth.login",
      subjectKey: "alice@example.com",
      attemptCount: 2,
      windowStartedAt: new Date("2026-03-30T10:00:00.000Z"),
      blockedUntil: new Date("2026-03-30T10:01:00.000Z"),
    });

    expect(saved.attemptCount).toBe(2);
    expect(saved.blockedUntil?.toISOString()).toBe("2026-03-30T10:01:00.000Z");

    const found = await repository.find("auth.login", "alice@example.com");
    expect(found).toEqual(saved);

    await repository.deleteExpired(new Date("2026-03-30T10:02:00.000Z"));
    await expect(repository.find("auth.login", "alice@example.com")).resolves.toBeNull();
  });
});
