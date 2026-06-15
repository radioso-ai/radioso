import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient, type QueryResultRow } from "pg";

import { CustomerEmailConnectionRepository } from "../../../src/db/repositories/customerEmailConnectionRepository.js";
import { EmailSkillActivityRepository } from "../../../src/db/repositories/emailSkillActivityRepository.js";
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

describeIfDatabase("email skill activity repository (postgres)", () => {
  const schema = `test_email_skill_activity_${randomUUID().replace(/-/g, "")}`;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const oauthConnectionId = randomUUID();

  let pool: pg.Pool;
  let client: PoolClient;
  let repository: EmailSkillActivityRepository;
  let skillId: string;
  let connectionId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY)`);
    await client.query(`CREATE TABLE agents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE)`);
    await client.query(await readFile(path.join(testMigrationsPath, "093_external_skills.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "094_external_skills_oauth_flow.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "095_integration_oauth_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "096_customer_email_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "097_email_skill_definitions.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "098_email_skill_activity.sql"), "utf8"));
    // 099/100 re-home skill definitions onto the shared agent_skills spine.
    await client.query(await readFile(path.join(testMigrationsPath, "099_agent_skills_spine.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "100_email_skills_into_spine.sql"), "utf8"));
    await client.query(`INSERT INTO workspaces (id) VALUES ($1), ($2)`, [workspaceId, otherWorkspaceId]);
    await client.query(`INSERT INTO agents (id, workspace_id) VALUES ($1, $2)`, [agentId, workspaceId]);
    await client.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, 'google_mail', 'Support Gmail', 'authorized', ARRAY['mail.send'])`,
      [oauthConnectionId, workspaceId],
    );

    const db = clientBackedDatabase(client);
    const connectionRepository = new CustomerEmailConnectionRepository(db);
    const skillRepository = new EmailSkillDefinitionRepository(db);
    repository = new EmailSkillActivityRepository(db);
    connectionId = (await connectionRepository.create({
      workspaceId,
      oauthConnectionId,
      provider: "google_mail",
      displayName: "Support outbound",
      senderEmail: "support@example.com",
    })).id;
    skillId = (await skillRepository.create({
      workspaceId,
      agentId,
      connectionId,
      skillName: "support_email_customer",
      mode: "send",
      boundInputs: { subject: "Follow-up", bodyText: "Secret body" },
      exposedInputs: { to: { slotBinding: "customerEmail" } },
    })).id;
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("records and lists sanitized activity scoped to the workspace", async () => {
    const created = await repository.record({
      workspaceId,
      agentId,
      routineId: randomUUID(),
      conversationId: randomUUID(),
      skillDefinitionId: skillId,
      connectionId,
      skillName: "support_email_customer",
      mode: "send",
      outcome: "sent",
      recipientSummary: {
        toCount: 1,
        ccCount: 0,
        domains: ["example.com"],
        redactedRecipients: ["c***@example.com"],
      },
      providerMessageId: "provider-message-1",
      errorCode: null,
    });

    expect(created).toMatchObject({
      workspaceId,
      agentId,
      skillDefinitionId: skillId,
      connectionId,
      skillName: "support_email_customer",
      mode: "send",
      outcome: "sent",
      providerMessageId: "provider-message-1",
      errorCode: null,
    });
    expect(JSON.stringify(created)).not.toContain("Secret body");

    const listed = await repository.list({ workspaceId, limit: 10 });
    expect(listed).toEqual([expect.objectContaining({ id: created.id })]);
    expect(await repository.list({ workspaceId: otherWorkspaceId, limit: 10 })).toEqual([]);
  });

  it("filters by agent, connection, skill, outcome, and date range", async () => {
    const created = await repository.record({
      workspaceId,
      agentId,
      routineId: null,
      conversationId: null,
      skillDefinitionId: skillId,
      connectionId,
      skillName: "support_email_customer",
      mode: "send",
      outcome: "needs_reauth",
      recipientSummary: { toCount: 0, ccCount: 0, domains: [], redactedRecipients: [] },
      providerMessageId: null,
      errorCode: "needs_reauth",
    });

    const matches = await repository.list({
      workspaceId,
      agentId,
      connectionId,
      skillDefinitionId: skillId,
      outcome: "needs_reauth",
      createdFrom: new Date(Date.now() - 60_000),
      createdTo: new Date(Date.now() + 60_000),
      limit: 5,
    });
    expect(matches.map((record) => record.id)).toContain(created.id);

    expect(await repository.list({ workspaceId, outcome: "provider_rejected", limit: 5 })).toEqual([]);
  });
});
