import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient, type QueryResultRow } from "pg";

import { CustomerEmailConnectionRepository } from "../../../src/db/repositories/customerEmailConnectionRepository.js";
import { EmailSkillDefinitionRepository } from "../../../src/db/repositories/emailSkillDefinitionRepository.js";
import type { Database } from "../../../src/shared/infra/database.js";
import { testMigrationsPath } from "../../support/databaseMigrations.js";

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

const clientBackedDatabase = (client: PoolClient): Database =>
  ({
    pool: {} as Database["pool"],
    async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await client.query<T>(text, params)).rows;
    },
    async execute(text: string, params: unknown[] = []): Promise<number> {
      return (await client.query(text, params)).rowCount ?? 0;
    },
  }) as Database;

describeIfDatabase("email skill definition repository (postgres)", () => {
  const schema = `test_email_skill_definitions_${randomUUID().replace(/-/g, "")}`;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const oauthConnectionId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;
  let repository: EmailSkillDefinitionRepository;
  let connectionRepository: CustomerEmailConnectionRepository;
  let connectionId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY)`);
    await client.query(`CREATE TABLE agents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE)`);
    await client.query(await readFile(path.join(testMigrationsPath, "095_integration_oauth_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "096_customer_email_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "097_email_skill_definitions.sql"), "utf8"));
    await client.query(`INSERT INTO workspaces (id) VALUES ($1), ($2)`, [workspaceId, otherWorkspaceId]);
    await client.query(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2), ($3, $4)`, [
      agentId,
      workspaceId,
      otherAgentId,
      otherWorkspaceId,
    ]);
    await client.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, 'google_mail', 'Support Gmail', 'authorized', ARRAY['mail.send'])`,
      [oauthConnectionId, workspaceId],
    );

    const db = clientBackedDatabase(client);
    connectionRepository = new CustomerEmailConnectionRepository(db);
    repository = new EmailSkillDefinitionRepository(db);
    connectionId = (await connectionRepository.create({
      workspaceId,
      oauthConnectionId,
      provider: "google_mail",
      displayName: "Support outbound",
      senderEmail: "support@example.com",
    })).id;
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("round-trips workspace and agent scoped email skill definitions", async () => {
    const created = await repository.create({
      workspaceId,
      agentId,
      connectionId,
      skillName: "support_email_customer",
      mode: "draft",
      boundInputs: { subject: "Support follow-up", replyTo: "support@example.com" },
      exposedInputs: {
        to: { slotBinding: "customerEmail" },
        bodyText: { slotBinding: "emailBody" },
      },
      enabled: true,
    });

    expect(created).toMatchObject({
      workspaceId,
      agentId,
      connectionId,
      skillName: "support_email_customer",
      mode: "draft",
      enabled: true,
    });
    expect(await repository.findById(workspaceId, agentId, created.id)).toMatchObject({ id: created.id });
    expect(await repository.findById(otherWorkspaceId, agentId, created.id)).toBeNull();
    expect(await repository.findEnabledByName(workspaceId, agentId, "support_email_customer")).toMatchObject({ id: created.id });
    expect(await repository.listByAgent(workspaceId, agentId)).toHaveLength(1);
    expect(await repository.listByAgent(workspaceId, otherAgentId)).toHaveLength(0);
  });

  it("updates mutable fields and counts connection references", async () => {
    const created = await repository.create({
      workspaceId,
      agentId,
      connectionId,
      skillName: "billing_email_customer",
      mode: "draft",
      boundInputs: { subject: "Billing follow-up" },
      exposedInputs: {
        to: { slotBinding: "customerEmail" },
        bodyText: { slotBinding: "emailBody" },
      },
    });

    expect(await connectionRepository.countSkillReferences(workspaceId, connectionId)).toBeGreaterThanOrEqual(1);

    const updated = await repository.update(workspaceId, agentId, created.id, {
      mode: "send",
      enabled: false,
      boundInputs: {
        subject: "Billing follow-up",
        bodyText: "Thanks for contacting billing.",
      },
      exposedInputs: {
        to: { slotBinding: "customerEmail" },
      },
    });

    expect(updated).toMatchObject({
      id: created.id,
      mode: "send",
      enabled: false,
      boundInputs: {
        subject: "Billing follow-up",
        bodyText: "Thanks for contacting billing.",
      },
    });

    expect(await repository.findEnabledByName(workspaceId, agentId, "billing_email_customer")).toBeNull();
  });
});
