import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient, type QueryResultRow } from "pg";

import { CustomerEmailConnectionRepository } from "../../../src/db/repositories/customerEmailConnectionRepository.js";
import type { Database } from "../../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../../src/shared/infra/kysely/kyselyDatabase.js";
import { testMigrationsPath } from "../../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) {
    return false;
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

const hasDatabase = await canReach(integrationDatabaseUrl);
const describeIfDatabase = hasDatabase ? describe : describe.skip;

const clientBackedDatabase = (client: PoolClient): Database => {
  const pool = {
    async connect() {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "release") return () => undefined;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as Database["pool"];
  return {
    pool,
    kysely: createKyselyDatabase(pool),
    async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await client.query<T>(text, params)).rows;
    },
    async execute(text: string, params: unknown[] = []): Promise<number> {
      return (await client.query(text, params)).rowCount ?? 0;
    },
  } as Database;
};

describeIfDatabase("customer email connection repository (postgres)", () => {
  const schema = `test_customer_email_connections_${randomUUID().replace(/-/g, "")}`;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const oauthConnectionId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;
  let repository: CustomerEmailConnectionRepository;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY)`);
    await client.query(await readFile(path.join(testMigrationsPath, "095_integration_oauth_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "105_integration_connections.sql"), "utf8"));
    await client.query(`INSERT INTO workspaces (id) VALUES ($1), ($2)`, [workspaceId, otherWorkspaceId]);
    await client.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, 'google_mail', 'Support Gmail', 'authorized', ARRAY['mail.send'])`,
      [oauthConnectionId, workspaceId],
    );

    repository = new CustomerEmailConnectionRepository(clientBackedDatabase(client));
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("round-trips a workspace-scoped customer email connection", async () => {
    const created = await repository.create({
      workspaceId,
      oauthConnectionId,
      provider: "google_mail",
      displayName: "Support outbound",
      senderEmail: "support@example.com",
      senderName: "Example Support",
      replyToEmail: "reply@example.com",
    });

    expect(created).toMatchObject({
      workspaceId,
      oauthConnectionId,
      provider: "google_mail",
      displayName: "Support outbound",
      senderEmail: "support@example.com",
      senderName: "Example Support",
      replyToEmail: "reply@example.com",
      status: "authorized",
      lastHealthStatus: null,
      lastErrorCode: null,
    });

    expect(await repository.findById(workspaceId, created.id)).toMatchObject({ id: created.id });
    expect(await repository.findById(otherWorkspaceId, created.id)).toBeNull();
    expect(await repository.listByWorkspace(workspaceId)).toHaveLength(1);
    expect(await repository.listByWorkspace(otherWorkspaceId)).toHaveLength(0);
  });

  it("updates mutable metadata, status, and health fields", async () => {
    const created = await repository.create({
      workspaceId,
      oauthConnectionId,
      provider: "google_mail",
      displayName: "Old",
      senderEmail: "old@example.com",
    });
    const checkedAt = new Date("2026-06-15T10:00:00.000Z");

    const updated = await repository.update(workspaceId, created.id, {
      displayName: "New",
      senderEmail: "new@example.com",
      senderName: null,
      replyToEmail: "reply@example.com",
      status: "error",
      lastHealthStatus: "failed",
      lastHealthCheckedAt: checkedAt,
      lastErrorCode: "provider_unavailable",
    });

    expect(updated).toMatchObject({
      displayName: "New",
      senderEmail: "new@example.com",
      senderName: null,
      replyToEmail: "reply@example.com",
      status: "error",
      lastHealthStatus: "failed",
      lastHealthCheckedAt: checkedAt,
      lastErrorCode: "provider_unavailable",
    });
  });

  it("counts references and removes by workspace", async () => {
    const created = await repository.create({
      workspaceId,
      oauthConnectionId,
      provider: "google_mail",
      displayName: "Delete me",
      senderEmail: "delete@example.com",
    });

    expect(await repository.countSkillReferences(workspaceId, created.id)).toBe(0);
    expect(await repository.remove(otherWorkspaceId, created.id)).toBe(false);
    expect(await repository.remove(workspaceId, created.id)).toBe(true);
    expect(await repository.findById(workspaceId, created.id)).toBeNull();
  });

  it("cannot read, mutate, or delete a non-email integration connection by id", async () => {
    // A different provider (e.g. Slack) owns a row on the shared spine in the same workspace.
    const foreignId = randomUUID();
    await client.query(
      `INSERT INTO integration_connections
         (id, workspace_id, oauth_connection_id, provider, display_name, status, config)
       VALUES ($1, $2, $3, 'slack', 'Workspace Slack', 'authorized', '{}'::jsonb)`,
      [foreignId, workspaceId, oauthConnectionId],
    );

    // Same workspace + a valid UUID, but the customer-email repository must not see it...
    expect(await repository.findById(workspaceId, foreignId)).toBeNull();
    expect(
      await repository.update(workspaceId, foreignId, { displayName: "hijacked", status: "disabled" }),
    ).toBeNull();
    expect(await repository.remove(workspaceId, foreignId)).toBe(false);
    expect((await repository.listByWorkspace(workspaceId)).some((c) => c.id === foreignId)).toBe(false);

    // ...and the foreign row must remain untouched.
    const remaining = await client.query<{ display_name: string; status: string }>(
      `SELECT display_name, status FROM integration_connections WHERE id = $1`,
      [foreignId],
    );
    expect(remaining.rows[0]).toMatchObject({ display_name: "Workspace Slack", status: "authorized" });
  });
});
