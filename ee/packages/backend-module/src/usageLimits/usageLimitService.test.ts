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
    created_at: Date;
    updated_at: Date;
  }>();
  readonly answerCounters = new Map<string, number>();
  readonly operations: string[] = [];
  readonly documents: Array<{
    workspaceId: string;
    externalDocumentId: string | null;
    sourceKind: string;
  }> = [];
  readonly reservations = new Map<string, { accountId: string; workspaceId: string; expiresAt: Date }>();

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
});
