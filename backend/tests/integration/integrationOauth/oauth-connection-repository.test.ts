import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import pg, { type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OauthConnectionRepository } from "../../../src/db/repositories/oauthConnectionRepository.js";
import type { OauthTokenPersistencePort } from "../../../src/modules/integrationOauth/public.js";
import type { Database } from "../../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../../src/shared/infra/kysely/kyselyDatabase.js";
import { decryptField, encryptField } from "../../../src/shared/infra/crypto/fieldEncryption.js";
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
          if (property === "release") {
            return () => undefined;
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as Database["pool"];

  return {
    pool,
    // Kysely over the same client so the migrated repo shares this test's schema/search_path.
    kysely: createKyselyDatabase(pool),
    async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await client.query<T>(text, params)).rows;
    },
    async execute(text: string, params: unknown[] = []): Promise<number> {
      return (await client.query(text, params)).rowCount ?? 0;
    },
  } as Database;
};

describeIfDatabase("oauth connection repository (postgres)", () => {
  const schema = `test_oauth_connections_${randomUUID().replace(/-/g, "")}`;
  const encryptionKey = Buffer.alloc(32, 8).toString("base64");
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;
  let repository: OauthConnectionRepository;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY)`);
    await client.query(await readFile(path.join(testMigrationsPath, "095_integration_oauth_connections.sql"), "utf8"));
    await client.query(`INSERT INTO workspaces (id) VALUES ($1), ($2)`, [workspaceId, otherWorkspaceId]);

    repository = new OauthConnectionRepository(clientBackedDatabase(client).kysely);
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("round-trips a workspace-scoped OAuth connection and hides it from other workspaces", async () => {
    const clientCiphertext = encryptField(JSON.stringify({ clientId: "client-1" }), encryptionKey);
    const created = await repository.create({
      workspaceId,
      provider: "gmail",
      displayName: "Support Gmail",
      oauthClientCiphertext: clientCiphertext,
      grantedScopes: ["email.send", "email.read"],
    });

    expect(created).toMatchObject({
      workspaceId,
      provider: "gmail",
      providerAccountId: null,
      displayName: "Support Gmail",
      status: "pending",
      credentialCiphertext: null,
      oauthClientCiphertext: clientCiphertext,
      grantedScopes: ["email.send", "email.read"],
    });
    expect(decryptField(created.oauthClientCiphertext!, encryptionKey)).toContain("client-1");

    expect(await repository.findById(workspaceId, created.id)).toMatchObject({ id: created.id });
    expect(await repository.findById(otherWorkspaceId, created.id)).toBeNull();
    expect(await repository.listByWorkspace(workspaceId)).toHaveLength(1);
    expect(await repository.listByWorkspace(otherWorkspaceId)).toHaveLength(0);
  });

  it("stores OAuth flow and tokens through the shared token persistence port", async () => {
    const created = await repository.create({
      workspaceId,
      provider: "gmail",
      displayName: "Workspace Gmail",
      oauthClientCiphertext: encryptField(JSON.stringify({ clientId: "client-2" }), encryptionKey),
    });

    const flowCiphertext = encryptField(JSON.stringify({ state: "s", codeVerifier: "v" }), encryptionKey);
    const withFlow = await repository.setOauthFlow(workspaceId, created.id, flowCiphertext);
    expect(withFlow?.oauthFlowCiphertext).toBe(flowCiphertext);
    expect(withFlow?.status).toBe("pending");

    const persistence: OauthTokenPersistencePort = repository;
    expect(persistence).toBe(repository);
    const tokenCiphertext = encryptField(JSON.stringify({ accessToken: "at" }), encryptionKey);
    const authorized = await repository.setOauthTokens(workspaceId, created.id, tokenCiphertext, "k1");

    expect(authorized).toMatchObject({
      status: "authorized",
      credentialCiphertext: tokenCiphertext,
      oauthFlowCiphertext: null,
      encryptionKeyId: "k1",
      lastErrorCode: null,
    });
    expect(authorized?.lastRefreshAt).toBeInstanceOf(Date);

    const needsReauth = await repository.updateStatus(workspaceId, created.id, "needs_reauth");
    expect(needsReauth?.status).toBe("needs_reauth");
  });

  it("updates mutable metadata and removes by workspace", async () => {
    const created = await repository.create({
      workspaceId,
      provider: "outlook",
      displayName: "Old Name",
    });

    const updated = await repository.update(workspaceId, created.id, {
      displayName: "New Name",
      providerAccountId: "mailbox@example.com",
      grantedScopes: ["Mail.Send"],
      status: "disabled",
      lastErrorCode: "operator_disabled",
    });

    expect(updated).toMatchObject({
      displayName: "New Name",
      providerAccountId: "mailbox@example.com",
      grantedScopes: ["Mail.Send"],
      status: "disabled",
      lastErrorCode: "operator_disabled",
    });

    expect(await repository.remove(otherWorkspaceId, created.id)).toBe(false);
    expect(await repository.remove(workspaceId, created.id)).toBe(true);
    expect(await repository.findById(workspaceId, created.id)).toBeNull();
  });
});
