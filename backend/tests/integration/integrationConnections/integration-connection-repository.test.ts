import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient } from "pg";

import { IntegrationConnectionRepository } from "../../../src/modules/integrationConnections/repository.js";
import { createKyselyDatabase } from "../../../src/shared/infra/kysely/kyselyDatabase.js";
import { testMigrationsPath } from "../../support/databaseMigrations.js";

// Real-Postgres characterization of the IntegrationConnectionRepository after its
// migration from raw `pg` to Kysely. The behaviour asserted here — provider-scoped
// reads/mutates, jsonb config shallow-merge, DB-clock timestamps, and the COLUMNS
// projection — is the spec the Kysely rewrite must preserve exactly.

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
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

describeIfDatabase("integration connection repository (postgres, kysely)", () => {
  const schema = `test_integration_connections_${randomUUID().replace(/-/g, "")}`;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const slackOauthId = randomUUID();
  const emailOauthId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;
  let repository: IntegrationConnectionRepository;

  const seedOauth = async (id: string, provider: string): Promise<void> => {
    await client.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, $3, $4, 'authorized', ARRAY[]::text[])`,
      [id, workspaceId, provider, `${provider} oauth`],
    );
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY)`);
    await client.query(await readFile(path.join(testMigrationsPath, "095_integration_oauth_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "105_integration_connections.sql"), "utf8"));
    await client.query(`INSERT INTO workspaces (id) VALUES ($1), ($2)`, [workspaceId, otherWorkspaceId]);
    await seedOauth(slackOauthId, "slack");
    await seedOauth(emailOauthId, "customer_email_google");

    repository = new IntegrationConnectionRepository(createKyselyDatabase(asPool(client)));
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  const slackScope = ["slack"];

  it("creates a connection with defaults and round-trips the full record", async () => {
    const created = await repository.create({
      workspaceId,
      oauthConnectionId: slackOauthId,
      provider: "slack",
      displayName: "Slack workspace",
      config: { teamId: "T123" },
    });

    expect(created).toMatchObject({
      workspaceId,
      oauthConnectionId: slackOauthId,
      provider: "slack",
      displayName: "Slack workspace",
      status: "authorized",
      lastHealthStatus: null,
      lastHealthCheckedAt: null,
      lastErrorCode: null,
      config: { teamId: "T123" },
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const fetched = await repository.findById(workspaceId, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.config).toEqual({ teamId: "T123" });
  });

  it("scopes findById/update/remove to the provider set and hides out-of-scope rows", async () => {
    const email = await repository.create({
      workspaceId,
      oauthConnectionId: emailOauthId,
      provider: "customer_email_google",
      displayName: "Email",
      config: {},
    });

    // out of slack scope -> invisible
    expect(await repository.findById(workspaceId, email.id, slackScope)).toBeNull();
    // unscoped -> visible
    expect((await repository.findById(workspaceId, email.id))?.id).toBe(email.id);

    // update refuses out-of-scope row, leaving it untouched
    expect(await repository.update(workspaceId, email.id, { displayName: "hijacked" }, slackScope)).toBeNull();
    expect((await repository.findById(workspaceId, email.id))?.displayName).toBe("Email");

    // remove refuses out-of-scope row
    expect(await repository.remove(workspaceId, email.id, slackScope)).toBe(false);
    expect(await repository.findById(workspaceId, email.id)).not.toBeNull();
  });

  it("shallow-merges jsonb config and bumps updated_at on the DB clock", async () => {
    const created = await repository.create({
      workspaceId,
      oauthConnectionId: slackOauthId,
      provider: "slack",
      displayName: "Merge me",
      config: { a: 1, nested: { keep: true } },
    });

    const updated = await repository.update(workspaceId, created.id, {
      status: "needs_reauth",
      lastHealthStatus: "failed",
      lastErrorCode: "token_revoked",
      config: { b: 2, nested: { replaced: true } },
    });

    // Right keys win; top-level merge is shallow (nested fully replaced).
    expect(updated?.config).toEqual({ a: 1, b: 2, nested: { replaced: true } });
    expect(updated?.status).toBe("needs_reauth");
    expect(updated?.lastHealthStatus).toBe("failed");
    expect(updated?.lastErrorCode).toBe("token_revoked");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it("returns the existing row unchanged for an empty update patch", async () => {
    const created = await repository.create({
      workspaceId,
      oauthConnectionId: slackOauthId,
      provider: "slack",
      displayName: "No-op",
      config: { x: 1 },
    });
    const result = await repository.update(workspaceId, created.id, {});
    expect(result?.id).toBe(created.id);
    expect(result?.config).toEqual({ x: 1 });
    expect(result?.displayName).toBe("No-op");
  });

  it("lists by workspace and by provider in created_at order", async () => {
    const ws = randomUUID();
    const oauthA = randomUUID();
    await client.query(`INSERT INTO workspaces (id) VALUES ($1)`, [ws]);
    await client.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, 'slack', 'oauth', 'authorized', ARRAY[]::text[])`,
      [oauthA, ws],
    );
    const first = await new IntegrationConnectionRepository(createKyselyDatabase(asPool(client))).create({
      workspaceId: ws,
      oauthConnectionId: oauthA,
      provider: "slack",
      displayName: "first",
      config: {},
    });
    const second = await repository.create({
      workspaceId: ws,
      oauthConnectionId: oauthA,
      provider: "customer_email_google",
      displayName: "second",
      config: {},
    });

    const all = await repository.listByWorkspace(ws);
    expect(all.map((r) => r.id)).toEqual([first.id, second.id]);

    const slackOnly = await repository.listByWorkspaceProvider(ws, "slack");
    expect(slackOnly.map((r) => r.id)).toEqual([first.id]);
  });

  it("removes an in-scope row and reports the deletion", async () => {
    const created = await repository.create({
      workspaceId,
      oauthConnectionId: slackOauthId,
      provider: "slack",
      displayName: "Delete me",
      config: {},
    });
    expect(await repository.remove(workspaceId, created.id, slackScope)).toBe(true);
    expect(await repository.remove(workspaceId, created.id, slackScope)).toBe(false);
    expect(await repository.findById(workspaceId, created.id)).toBeNull();
  });
});

// A Pool facade over a single pinned client, so every statement (and the Kysely
// builder) runs on the same connection that owns the test's temporary schema.
const asPool = (client: PoolClient): pg.Pool =>
  ({
    async connect() {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "release") return () => undefined;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  }) as unknown as pg.Pool;
