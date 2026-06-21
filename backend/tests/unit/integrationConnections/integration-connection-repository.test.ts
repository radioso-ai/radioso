import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";

import {
  IntegrationConnectionRepository,
  type IntegrationConnectionRow,
} from "../../../src/modules/integrationConnections/repository.js";
import type { DatabaseExecutor } from "../../../src/shared/infra/database.js";

class ScriptedDatabase implements DatabaseExecutor {
  readonly queries: Array<{ text: string; params: unknown[] }> = [];
  readonly executions: Array<{ text: string; params: unknown[] }> = [];
  private readonly queuedRows: QueryResultRow[][] = [];

  queueRows<T extends QueryResultRow>(rows: T[]): void {
    this.queuedRows.push(rows);
  }

  async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    return (this.queuedRows.shift() ?? []) as T[];
  }

  async queryOptional<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
    const row = await this.queryOptional<T>(text, params);
    if (!row) throw new Error("Expected query to return one row");
    return row;
  }

  async execute(text: string, params: unknown[] = []): Promise<number> {
    this.executions.push({ text, params });
    return 1;
  }
}

const row = (overrides: Partial<IntegrationConnectionRow> = {}): IntegrationConnectionRow => ({
  id: overrides.id ?? randomUUID(),
  workspace_id: overrides.workspace_id ?? randomUUID(),
  oauth_connection_id: overrides.oauth_connection_id ?? randomUUID(),
  provider: overrides.provider ?? "customer_email_google",
  display_name: overrides.display_name ?? "Support Gmail",
  status: overrides.status ?? "authorized",
  last_health_status: overrides.last_health_status ?? null,
  last_health_checked_at: overrides.last_health_checked_at ?? null,
  last_error_code: overrides.last_error_code ?? null,
  config: overrides.config ?? { senderEmail: "support@example.com" },
  created_at: overrides.created_at ?? new Date("2026-06-15T10:00:00.000Z"),
  updated_at: overrides.updated_at ?? new Date("2026-06-15T10:00:00.000Z"),
});

describe("IntegrationConnectionRepository", () => {
  it("creates OAuth-backed workspace integration connections without credential material", async () => {
    const database = new ScriptedDatabase();
    const createdRow = row({ config: { senderEmail: "support@example.com", senderName: "Support" } });
    database.queueRows([createdRow]);
    const repository = new IntegrationConnectionRepository(database);

    const created = await repository.create({
      workspaceId: createdRow.workspace_id,
      oauthConnectionId: createdRow.oauth_connection_id,
      provider: "customer_email_google",
      displayName: "Support Gmail",
      config: { senderEmail: "support@example.com", senderName: "Support" },
    });

    expect(created).toMatchObject({
      id: createdRow.id,
      workspaceId: createdRow.workspace_id,
      oauthConnectionId: createdRow.oauth_connection_id,
      provider: "customer_email_google",
      displayName: "Support Gmail",
      config: { senderEmail: "support@example.com", senderName: "Support" },
      status: "authorized",
    });
    expect(database.queries[0]?.text).toContain("INSERT INTO integration_connections");
    expect(JSON.stringify(database.queries[0]?.params)).not.toContain("access_token");
  });

  it("updates lifecycle fields and merges provider config", async () => {
    const database = new ScriptedDatabase();
    const updatedAt = new Date("2026-06-15T11:00:00.000Z");
    database.queueRows([
      row({
        display_name: "Renamed",
        status: "error",
        last_health_status: "failed",
        last_health_checked_at: updatedAt,
        last_error_code: "provider_unavailable",
        config: { senderEmail: "new@example.com", replyToEmail: "reply@example.com" },
        updated_at: updatedAt,
      }),
    ]);
    const repository = new IntegrationConnectionRepository(database);
    const workspaceId = randomUUID();
    const id = randomUUID();

    const updated = await repository.update(workspaceId, id, {
      displayName: "Renamed",
      status: "error",
      lastHealthStatus: "failed",
      lastHealthCheckedAt: updatedAt,
      lastErrorCode: "provider_unavailable",
      config: { senderEmail: "new@example.com", replyToEmail: "reply@example.com" },
    });

    expect(updated).toMatchObject({
      displayName: "Renamed",
      status: "error",
      lastHealthStatus: "failed",
      lastHealthCheckedAt: updatedAt,
      lastErrorCode: "provider_unavailable",
      config: { senderEmail: "new@example.com", replyToEmail: "reply@example.com" },
    });
    expect(database.queries[0]?.text).toContain("config = config ||");
  });
});
