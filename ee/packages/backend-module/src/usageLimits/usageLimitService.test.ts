import { describe, expect, it } from "vitest";

import type { UsageLimitDatabaseClient, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { UsageLimitExceededError } from "./errors.js";
import { EnterpriseUsageLimitService } from "./usageLimitService.js";

class FakeUsageLimitDatabase implements UsageLimitDatabasePort {
  readonly workspaceAccounts = new Map<string, string>();
  readonly assignments = new Map<string, string>();
  readonly profiles = new Map<string, {
    key: string;
    display_name: string;
    monthly_answer_limit: number | null;
    stored_document_limit: number | null;
    stored_indexed_byte_limit: number | null;
    monthly_indexed_byte_limit: number | null;
    created_at: Date;
    updated_at: Date;
  }>();
  readonly answerCounters = new Map<string, number>();
  readonly operations: string[] = [];
  readonly documents: Array<{
    workspaceId: string;
    externalDocumentId: string | null;
    sourceKind: string;
    contentSizeBytes?: number | null;
  }> = [];
  readonly assistantMessages: Array<{
    workspaceId: string;
    createdAt: Date;
  }> = [];
  readonly reservations = new Map<string, { accountId: string; workspaceId: string; expiresAt: Date }>();
  readonly storageReservations = new Map<string, { accountId: string; workspaceId: string; bytesReserved: number; expiresAt: Date }>();
  readonly monthlyIndexedByteCounters = new Map<string, number>();

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    if (text.includes("pg_advisory_xact_lock")) {
      this.operations.push(`lock:${String(params[0])}`);
      return [] as T[];
    }

    if (text.includes("SELECT account_id FROM workspaces")) {
      const accountId = this.workspaceAccounts.get(String(params[0]));
      return (accountId ? [{ account_id: accountId }] : []) as T[];
    }

    if (text.includes("FROM ee_usage_limit_account_assignments a")) {
      const profileKey = this.assignments.get(String(params[0]));
      const profile = profileKey ? this.profiles.get(profileKey) : null;
      return (profile ? [profile] : []) as T[];
    }

    if (text.includes("INSERT INTO ee_usage_limit_answer_counters")) {
      const key = answerCounterKey(String(params[0]), String(params[1]));
      if (!this.answerCounters.has(key)) {
        this.answerCounters.set(key, 0);
      }
      return [] as T[];
    }

    if (text.includes("SET used_count = used_count + 1")) {
      const key = answerCounterKey(String(params[0]), String(params[1]));
      const current = this.answerCounters.get(key) ?? 0;
      const limit = Number(params[2]);
      if (current >= limit) {
        return [] as T[];
      }
      this.answerCounters.set(key, current + 1);
      return [{ used_count: current + 1 }] as T[];
    }

    if (text.includes("SET used_count = GREATEST")) {
      const key = answerCounterKey(String(params[0]), String(params[1]));
      this.answerCounters.set(key, Math.max((this.answerCounters.get(key) ?? 0) - 1, 0));
      return [] as T[];
    }

    if (text.includes("FROM ee_usage_limit_answer_counters")) {
      const key = answerCounterKey(String(params[0]), String(params[1]));
      return [{ used_count: this.answerCounters.get(key) ?? 0 }] as T[];
    }

    if (text.includes("INSERT INTO ee_usage_limit_monthly_indexed_byte_counters") && text.includes("ON CONFLICT")) {
      const key = answerCounterKey(String(params[0]), String(params[1]));
      if (!this.monthlyIndexedByteCounters.has(key)) {
        this.monthlyIndexedByteCounters.set(key, 0);
      }
      return [] as T[];
    }

    if (text.includes("UPDATE ee_usage_limit_monthly_indexed_byte_counters") && text.includes("used_bytes + $3 <=")) {
      const key = answerCounterKey(String(params[0]), String(params[1]));
      const delta = Number(params[2]);
      const limit = Number(params[3]);
      const current = this.monthlyIndexedByteCounters.get(key) ?? 0;
      if (current + delta > limit) {
        return [] as T[];
      }
      this.monthlyIndexedByteCounters.set(key, current + delta);
      return [{ used_bytes: current + delta }] as T[];
    }

    if (
      text.includes("UPDATE ee_usage_limit_monthly_indexed_byte_counters")
      && text.includes("used_bytes = used_bytes + $3")
      && !text.includes("used_bytes + $3 <=")
    ) {
      const key = answerCounterKey(String(params[0]), String(params[1]));
      const delta = Number(params[2]);
      const current = this.monthlyIndexedByteCounters.get(key) ?? 0;
      this.monthlyIndexedByteCounters.set(key, current + delta);
      return [{ used_bytes: current + delta }] as T[];
    }

    if (text.includes("UPDATE ee_usage_limit_monthly_indexed_byte_counters") && text.includes("GREATEST")) {
      const key = answerCounterKey(String(params[0]), String(params[1]));
      const delta = Number(params[2]);
      this.monthlyIndexedByteCounters.set(key, Math.max((this.monthlyIndexedByteCounters.get(key) ?? 0) - delta, 0));
      return [] as T[];
    }

    if (text.includes("SELECT used_bytes") && text.includes("FROM ee_usage_limit_monthly_indexed_byte_counters")) {
      const key = answerCounterKey(String(params[0]), String(params[1]));
      return [{ used_bytes: this.monthlyIndexedByteCounters.get(key) ?? 0 }] as T[];
    }

    if (text.includes("FROM messages m")) {
      const accountId = String(params[0]);
      const periodStart = new Date(String(params[1]));
      const resetAt = new Date(String(params[2]));
      const count = this.assistantMessages.filter((message) =>
        this.workspaceAccounts.get(message.workspaceId) === accountId &&
        message.createdAt >= periodStart &&
        message.createdAt < resetAt
      ).length;
      return [{ count: String(count) }] as T[];
    }

    if (text.includes("SUM(d.content_size_bytes)")) {
      this.operations.push("sum_content_bytes");
      const accountId = String(params[0]);
      const bytes = this.documents
        .filter((document) => this.workspaceAccounts.get(document.workspaceId) === accountId)
        .reduce((acc, document) => acc + Number(document.contentSizeBytes ?? 0), 0);
      return [{ bytes: String(bytes) }] as T[];
    }

    if (text.includes("FROM documents d")) {
      this.operations.push("count_documents");
      const accountId = String(params[0]);
      const count = this.documents.filter((document) =>
        this.workspaceAccounts.get(document.workspaceId) === accountId
      ).length;
      return [{ count: String(count) }] as T[];
    }

    if (text.includes("FROM ee_usage_limit_document_reservations")) {
      const accountId = String(params[0]);
      const count = [...this.reservations.values()].filter((reservation) => reservation.accountId === accountId).length;
      return [{ count: String(count) }] as T[];
    }

    if (text.includes("DELETE FROM ee_usage_limit_document_reservations") && text.includes("expires_at")) {
      return [] as T[];
    }

    if (text.includes("INSERT INTO ee_usage_limit_document_reservations")) {
      this.reservations.set(String(params[0]), {
        accountId: String(params[1]),
        workspaceId: String(params[2]),
        expiresAt: new Date(String(params[3])),
      });
      return [] as T[];
    }

    if (text.includes("DELETE FROM ee_usage_limit_document_reservations WHERE id")) {
      this.reservations.delete(String(params[0]));
      return [] as T[];
    }

    if (text.includes("DELETE FROM ee_usage_limit_storage_reservations") && text.includes("expires_at")) {
      return [] as T[];
    }

    if (text.includes("SUM(bytes_reserved)")) {
      this.operations.push("sum_storage_reservations");
      const accountId = String(params[0]);
      const bytes = [...this.storageReservations.values()]
        .filter((reservation) => reservation.accountId === accountId)
        .reduce((acc, reservation) => acc + reservation.bytesReserved, 0);
      return [{ bytes: String(bytes) }] as T[];
    }

    if (text.includes("INSERT INTO ee_usage_limit_storage_reservations")) {
      this.storageReservations.set(String(params[0]), {
        accountId: String(params[1]),
        workspaceId: String(params[2]),
        bytesReserved: Number(params[3]),
        expiresAt: new Date(String(params[4])),
      });
      return [] as T[];
    }

    if (text.includes("DELETE FROM ee_usage_limit_storage_reservations WHERE id")) {
      this.storageReservations.delete(String(params[0]));
      return [] as T[];
    }

    if (text.includes("external_document_id = $2")) {
      const workspaceId = String(params[0]);
      const externalDocumentId = String(params[1]);
      const exists = this.documents.some((document) =>
        document.workspaceId === workspaceId &&
        document.externalDocumentId === externalDocumentId &&
        document.sourceKind === "inline_text"
      );
      return (exists ? [{ id: "doc-1" }] : []) as T[];
    }

    return [] as T[];
  }

  async withTransaction<T>(callback: (client: UsageLimitDatabaseClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const answerCounterKey = (accountId: string, periodStart: string) => `${accountId}:${periodStart}`;

const configureStarter = (database: FakeUsageLimitDatabase, input: {
  accountId?: string;
  workspaceId?: string;
  monthlyAnswerLimit?: number | null;
  storedDocumentLimit?: number | null;
  storedIndexedByteLimit?: number | null;
  monthlyIndexedByteLimit?: number | null;
}) => {
  const accountId = input.accountId ?? "account-1";
  const workspaceId = input.workspaceId ?? "workspace-1";
  database.workspaceAccounts.set(workspaceId, accountId);
  database.assignments.set(accountId, "starter_250");
  database.profiles.set("starter_250", {
    key: "starter_250",
    display_name: "Starter 250",
    monthly_answer_limit: input.monthlyAnswerLimit ?? 250,
    stored_document_limit: input.storedDocumentLimit ?? 250,
    stored_indexed_byte_limit: input.storedIndexedByteLimit ?? null,
    monthly_indexed_byte_limit: input.monthlyIndexedByteLimit ?? null,
    created_at: new Date("2026-05-01T00:00:00.000Z"),
    updated_at: new Date("2026-05-01T00:00:00.000Z"),
  });
};

describe("enterprise usage limit service", () => {
  it("leaves unassigned accounts unlimited", async () => {
    const database = new FakeUsageLimitDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveAnswer({
      workspaceId: "workspace-1",
      surface: "assistant",
    });
    await reservation.commit();

    expect(database.answerCounters.size).toBe(0);
  });

  it("reports persisted assistant messages for uncapped account usage", async () => {
    const database = new FakeUsageLimitDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    database.assistantMessages.push(
      { workspaceId: "workspace-1", createdAt: new Date("2026-05-05T12:00:00.000Z") },
      { workspaceId: "workspace-1", createdAt: new Date("2026-05-06T12:00:00.000Z") },
      { workspaceId: "workspace-1", createdAt: new Date("2026-04-30T12:00:00.000Z") },
    );
    const service = new EnterpriseUsageLimitService(database);

    const usage = await service.getAccountUsage("account-1", "2026-05-01");

    expect(usage.profile).toBeNull();
    expect(usage.monthlyAnswers.used).toBe(2);
    expect(usage.monthlyAnswers.limit).toBeNull();
  });

  it("reserves monthly answer usage and releases failed attempts", async () => {
    const database = new FakeUsageLimitDatabase();
    configureStarter(database, { monthlyAnswerLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveAnswer({
      accountId: "account-1",
      workspaceId: "workspace-1",
      surface: "assistant",
    });

    await expect(service.reserveAnswer({
      accountId: "account-1",
      workspaceId: "workspace-1",
      surface: "assistant",
    })).rejects.toBeInstanceOf(UsageLimitExceededError);

    await reservation.release();

    await expect(service.reserveAnswer({
      accountId: "account-1",
      workspaceId: "workspace-1",
      surface: "assistant",
    })).resolves.toBeDefined();
  });

  it("blocks net-new documents while allowing existing external document upserts", async () => {
    const database = new FakeUsageLimitDatabase();
    configureStarter(database, { storedDocumentLimit: 1 });
    database.documents.push({
      workspaceId: "workspace-1",
      externalDocumentId: "existing-external",
      sourceKind: "inline_text",
    });
    const service = new EnterpriseUsageLimitService(database);

    await expect(service.reserveDocument({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sourceKind: "inline_text",
    })).rejects.toBeInstanceOf(UsageLimitExceededError);

    await expect(service.reserveDocument({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sourceKind: "inline_text",
      externalDocumentId: "existing-external",
    })).resolves.toBeDefined();
  });

  it("takes an account-scoped lock before checking document capacity", async () => {
    const database = new FakeUsageLimitDatabase();
    configureStarter(database, { storedDocumentLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveDocument({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sourceKind: "uploaded_file",
    });

    expect(database.operations.slice(0, 2)).toEqual(["lock:account-1", "count_documents"]);
    await reservation.release();
  });

  it("treats indexed storage as unlimited when the profile has no byte cap", async () => {
    const database = new FakeUsageLimitDatabase();
    configureStarter(database, { storedIndexedByteLimit: null });
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveIndexedStorage({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 10_000_000,
    });

    await reservation.commit();
    expect(database.storageReservations.size).toBe(0);
  });

  it("rejects indexed storage reservations that would exceed the configured byte cap", async () => {
    const database = new FakeUsageLimitDatabase();
    configureStarter(database, { storedIndexedByteLimit: 1_024 });
    database.documents.push({
      workspaceId: "workspace-1",
      externalDocumentId: null,
      sourceKind: "inline_text",
      contentSizeBytes: 1_000,
    });
    const service = new EnterpriseUsageLimitService(database);

    await expect(service.reserveIndexedStorage({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 50,
    })).rejects.toBeInstanceOf(UsageLimitExceededError);
  });

  it("locks the account, counts persisted bytes plus reservations, then inserts a TTL reservation", async () => {
    const database = new FakeUsageLimitDatabase();
    configureStarter(database, { storedIndexedByteLimit: 10_000 });
    const service = new EnterpriseUsageLimitService(database);

    const first = await service.reserveIndexedStorage({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 6_000,
    });

    expect(database.storageReservations.size).toBe(1);
    expect(database.operations.slice(0, 3)).toEqual([
      "lock:account-1",
      "sum_content_bytes",
      "sum_storage_reservations",
    ]);

    await expect(service.reserveIndexedStorage({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 5_000,
    })).rejects.toBeInstanceOf(UsageLimitExceededError);

    await first.release();
    expect(database.storageReservations.size).toBe(0);

    const next = await service.reserveIndexedStorage({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 5_000,
    });
    await next.commit();
  });

  it("exposes stored indexed bytes in account usage with byte limit from the profile", async () => {
    const database = new FakeUsageLimitDatabase();
    configureStarter(database, { storedIndexedByteLimit: 1_000_000 });
    database.documents.push({
      workspaceId: "workspace-1",
      externalDocumentId: null,
      sourceKind: "inline_text",
      contentSizeBytes: 4_096,
    });
    database.documents.push({
      workspaceId: "workspace-1",
      externalDocumentId: null,
      sourceKind: "uploaded_file",
      contentSizeBytes: 8_192,
    });
    const service = new EnterpriseUsageLimitService(database);

    const usage = await service.getAccountUsage("account-1", "2026-05-01");

    expect(usage.storedIndexedBytes).toEqual({ used: 4_096 + 8_192, limit: 1_000_000 });
  });

  it("returns a null indexed byte limit when no profile is assigned", async () => {
    const database = new FakeUsageLimitDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    const service = new EnterpriseUsageLimitService(database);

    const usage = await service.getAccountUsage("account-1", "2026-05-01");

    expect(usage.storedIndexedBytes).toEqual({ used: 0, limit: null });
    expect(usage.monthlyIndexedBytes).toEqual({
      periodStart: "2026-05-01",
      resetAt: expect.any(String),
      used: 0,
      limit: null,
    });
  });

  it("reserves monthly indexed content and rejects once the period budget is exhausted", async () => {
    const database = new FakeUsageLimitDatabase();
    configureStarter(database, { monthlyIndexedByteLimit: 10_000 });
    const service = new EnterpriseUsageLimitService(database);

    const first = await service.reserveMonthlyIndexedContent({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 6_000,
    });
    await first.commit();

    await expect(service.reserveMonthlyIndexedContent({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 5_000,
    })).rejects.toBeInstanceOf(UsageLimitExceededError);

    const second = await service.reserveMonthlyIndexedContent({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 4_000,
    });
    await second.commit();
  });

  it("meters monthly indexed content even when the account has no byte limit", async () => {
    const database = new FakeUsageLimitDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveMonthlyIndexedContent({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 5_000,
    });
    await reservation.commit();

    const usage = await service.getAccountUsage("account-1");
    expect(usage.monthlyIndexedBytes.used).toBe(5_000);
    expect(usage.monthlyIndexedBytes.limit).toBeNull();
  });

  it("releases the metered bytes on an unlimited account when the reservation is released", async () => {
    const database = new FakeUsageLimitDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveMonthlyIndexedContent({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 2_500,
    });
    await reservation.release();

    const usage = await service.getAccountUsage("account-1");
    expect(usage.monthlyIndexedBytes.used).toBe(0);
  });

  it("releases monthly indexed content reservations on failure", async () => {
    const database = new FakeUsageLimitDatabase();
    configureStarter(database, { monthlyIndexedByteLimit: 1_000 });
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveMonthlyIndexedContent({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 800,
    });

    await expect(service.reserveMonthlyIndexedContent({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 300,
    })).rejects.toBeInstanceOf(UsageLimitExceededError);

    await reservation.release();

    await expect(service.reserveMonthlyIndexedContent({
      accountId: "account-1",
      workspaceId: "workspace-1",
      contentSizeBytes: 300,
    })).resolves.toBeDefined();
  });
});
