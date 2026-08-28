import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { CustomerEmailConnectionRepository } from "../../src/db/repositories/customerEmailConnectionRepository.js";
import { EmailSkillDefinitionRepository } from "../../src/db/repositories/emailSkillDefinitionRepository.js";
import { ExternalSkillDefinitionRepository } from "../../src/db/repositories/externalSkillDefinitionRepository.js";
import { McpConnectionRepository } from "../../src/db/repositories/mcpConnectionRepository.js";
import { WebhookSkillDefinitionRepository } from "../../src/db/repositories/webhookSkillDefinitionRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentSkillRepository } from "../../src/modules/agentSkills/repository.js";
import { touchAgentSkillsWatermark } from "../../src/modules/agentSkills/skillsWatermark.js";
import { SlackSkillDefinitionRepository } from "../../src/modules/slackSkills/repository.js";
import { encryptField } from "../../src/shared/infra/crypto/fieldEncryption.js";
import { Database } from "../../src/shared/infra/database.js";
import { createKyselyDatabase } from "../../src/shared/infra/kysely/kyselyDatabase.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();
const encryptionKey = Buffer.alloc(32, 9).toString("base64");

// Wraps a single already-open pg client so Kysely (and everything built on it) issues every
// statement over that one connection/transaction instead of borrowing a fresh one from a pool -
// needed to interleave two independently-controlled transactions in the same test.
const asPool = (client: pg.PoolClient): pg.Pool =>
  ({
    async connect() {
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "release") return () => undefined;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as pg.PoolClient;
    },
  }) as unknown as pg.Pool;

// Finding 2 (agent_skills_watermarks never advanced on a delete performed by webhook, email,
// external MCP, or Slack skill repositories) and finding 3 (the watermark could move backward
// across two racing transactions) — both against real Postgres, since neither is expressible
// against the in-memory fake.
describeIntegration("agent_skills freshness watermark, across writers and racing transactions (Postgres)", () => {
  let database: Database;
  let repository: AgentSkillRepository;
  let agentRepository: AgentRepository;
  let workspaceId: string;
  let accountId: string;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl);
    repository = new AgentSkillRepository(database.kysely);

    const accountRepository = new AccountRepository(database.kysely);
    const workspaceRepository = new WorkspaceRepository(database.kysely);
    agentRepository = new AgentRepository(database.kysely);
    const account = await accountRepository.create({
      name: "Skill Watermark IT",
      email: `agent-skill-watermark-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    accountId = account.id;
    const workspace = await workspaceRepository.create(account.id, "Skill Watermark IT");
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await database?.close().catch(() => undefined);
  });

  it("advances the watermark when a webhook skill is deleted through WebhookSkillDefinitionRepository, not AgentSkillRepository", async () => {
    const agent = await agentRepository.create(workspaceId, { name: "Webhook Watermark Agent" });
    const destinationId = randomUUID();
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [destinationId, workspaceId, "Dest", "https://hooks.example.com", "enc", "key-1"],
    );
    const webhookSkills = new WebhookSkillDefinitionRepository(database.kysely);

    const created = await webhookSkills.create({
      workspaceId,
      agentId: agent.id,
      destinationId,
      skillName: "notify_ops",
      boundPayload: {},
      exposedPayload: {},
    });
    expect(await repository.latestUpdatedAt(workspaceId, agent.id)).not.toBeNull();

    // A real gap, not just statement order: create()'s own timestamp and the DELETE
    // trigger's clock_timestamp() read can otherwise land in the same millisecond and tie.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await webhookSkills.remove(workspaceId, agent.id, created.id)).toBe(true);
    const afterDelete = await repository.latestUpdatedAt(workspaceId, agent.id);
    expect(afterDelete).not.toBeNull();
    expect(afterDelete!.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it("advances the watermark when an email skill is deleted through EmailSkillDefinitionRepository, not AgentSkillRepository", async () => {
    const agent = await agentRepository.create(workspaceId, { name: "Email Watermark Agent" });
    const oauthConnectionId = randomUUID();
    await database.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, 'google_mail', 'Support Gmail', 'authorized', ARRAY['mail.send'])`,
      [oauthConnectionId, workspaceId],
    );
    const connections = new CustomerEmailConnectionRepository(database.kysely);
    const connection = await connections.create({
      workspaceId,
      oauthConnectionId,
      provider: "google_mail",
      displayName: "Support outbound",
      senderEmail: "support@example.com",
    });
    const emailSkills = new EmailSkillDefinitionRepository(database.kysely);

    const created = await emailSkills.create({
      workspaceId,
      agentId: agent.id,
      connectionId: connection.id,
      skillName: "support_email",
      mode: "draft",
      boundInputs: { to: "lead@example.com", subject: "Hi" },
      exposedInputs: {},
    });
    expect(await repository.latestUpdatedAt(workspaceId, agent.id)).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await emailSkills.remove(workspaceId, agent.id, created.id)).toBe(true);
    const afterDelete = await repository.latestUpdatedAt(workspaceId, agent.id);
    expect(afterDelete).not.toBeNull();
    expect(afterDelete!.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it("advances the watermark when an external MCP skill is deleted through ExternalSkillDefinitionRepository, not AgentSkillRepository", async () => {
    const agent = await agentRepository.create(workspaceId, { name: "External MCP Watermark Agent" });
    const connections = new McpConnectionRepository(database.kysely);
    const connection = await connections.create({
      agentId: agent.id,
      displayName: "Scheduler",
      serverUrl: "https://mcp.example.com",
      authMethod: "access_token",
      credentialCiphertext: encryptField("token", encryptionKey),
      encryptionKeyId: "key-1",
    });
    const externalSkills = new ExternalSkillDefinitionRepository(database.kysely);

    const created = await externalSkills.create({
      agentId: agent.id,
      connectionId: connection.id,
      skillName: "schedule_meeting",
      toolName: "schedule",
      boundParams: {},
      exposedParams: {},
    });
    expect(await repository.latestUpdatedAt(workspaceId, agent.id)).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await externalSkills.remove(agent.id, created.id)).toBe(true);
    const afterDelete = await repository.latestUpdatedAt(workspaceId, agent.id);
    expect(afterDelete).not.toBeNull();
    expect(afterDelete!.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it("advances the watermark when a Slack skill is deleted through slackSkills/repository.ts, not AgentSkillRepository", async () => {
    const agent = await agentRepository.create(workspaceId, { name: "Slack Watermark Agent" });
    const oauthConnectionId = randomUUID();
    const slackConnectionId = randomUUID();
    const installationId = randomUUID();
    await database.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status, granted_scopes)
       VALUES ($1, $2, 'slack', 'Slack', 'authorized', ARRAY['chat:write'])`,
      [oauthConnectionId, workspaceId],
    );
    await database.query(
      `INSERT INTO integration_connections (id, workspace_id, oauth_connection_id, provider, display_name, status, config)
       VALUES ($1, $2, $3, 'slack', 'Slack', 'authorized', '{}'::jsonb)`,
      [slackConnectionId, workspaceId, oauthConnectionId],
    );
    await database.query(
      `INSERT INTO slack_installations (id, connection_id, workspace_id, account_id, team_id, team_name, bot_user_id)
       VALUES ($1, $2, $3, $4, $5, 'Watermark Team', 'UBOT')`,
      [installationId, slackConnectionId, workspaceId, accountId, `T${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`],
    );
    const slackSkills = new SlackSkillDefinitionRepository(database.kysely);

    const created = await slackSkills.create({
      workspaceId,
      agentId: agent.id,
      installationId,
      skillName: "post_update",
      boundInputs: { channelId: "C1" },
      exposedInputs: {},
    });
    expect(await repository.latestUpdatedAt(workspaceId, agent.id)).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await slackSkills.remove(workspaceId, agent.id, created.id)).toBe(true);
    const afterDelete = await repository.latestUpdatedAt(workspaceId, agent.id);
    expect(afterDelete).not.toBeNull();
    expect(afterDelete!.getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
  });

  it("advances the watermark for a delete against agent_skills from any writer, including one no repository code names", async () => {
    // The trigger fires on the DELETE statement itself, not on a call site a repository author
    // has to remember - so it covers a hypothetical future writer too, simulated here with a raw
    // DELETE that never goes through any of this codebase's skill repositories.
    const agent = await agentRepository.create(workspaceId, { name: "Raw Writer Watermark Agent" });
    const inserted = await database.query<{ id: string; updated_at: string }>(
      `INSERT INTO agent_skills (id, workspace_id, agent_id, skill_name, kind, target_type, target_id, invocation_mode, enabled)
       VALUES ($1, $2, $3, 'theta', 'retrieve', 'source_scope', 'scope-1', 'routine_named', true)
       RETURNING id, updated_at`,
      [randomUUID(), workspaceId, agent.id],
    );
    const createdRow = inserted[0]!;
    expect(await repository.latestUpdatedAt(workspaceId, agent.id)).not.toBeNull();

    // A real gap, not just statement order: the INSERT's own timestamp and the DELETE trigger's
    // clock_timestamp() read can otherwise land in the same millisecond and tie.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await database.execute(`DELETE FROM agent_skills WHERE id = $1`, [createdRow.id]);
    const afterDelete = await repository.latestUpdatedAt(workspaceId, agent.id);
    expect(afterDelete).not.toBeNull();
    expect(afterDelete!.getTime()).toBeGreaterThan(new Date(createdRow.updated_at).getTime());
  });

  it("does not advance the watermark, or error, when an agent delete cascades into its own skills", async () => {
    // agent_skills_watermarks has the same ON DELETE CASCADE FK to agents as agent_skills does, so
    // the watermark row is removed by the same cascade. The delete trigger must recognize the
    // agent is already gone (in this same transaction) and skip its insert rather than trip a
    // foreign key violation that would abort the whole agent deletion.
    const agent = await agentRepository.create(workspaceId, { name: "Cascade Delete Watermark Agent" });
    await database.query(
      `INSERT INTO agent_skills (id, workspace_id, agent_id, skill_name, kind, target_type, target_id, invocation_mode, enabled)
       VALUES ($1, $2, $3, 'iota', 'retrieve', 'source_scope', 'scope-1', 'routine_named', true)`,
      [randomUUID(), workspaceId, agent.id],
    );
    expect(await repository.latestUpdatedAt(workspaceId, agent.id)).not.toBeNull();

    await expect(database.execute(`DELETE FROM agents WHERE id = $1`, [agent.id])).resolves.toBe(1);
    expect(await repository.latestUpdatedAt(workspaceId, agent.id)).toBeNull();
  });

  it("never lets the watermark move backward when an older, delayed transaction's write lands after a newer one already committed", async () => {
    // Finding 3: currentTimestamp() (now()) is fixed at transaction START, not at the moment the
    // statement runs. Reproduced honestly with two real, independently-controlled transactions on
    // the same underlying connection pool: T1 begins, then sleeps *before* touching the watermark
    // row at all (so it holds no lock on it yet and cannot block T2); T2 begins after T1, but has
    // no delay, so it writes and commits first. T1 then wakes and performs its own write - using
    // the buggy now()-at-BEGIN semantics, this write is stamped with a time from *before* T1 even
    // started sleeping, older than what T2 already committed, and the unconditional ON CONFLICT
    // overwrite regresses the stored watermark. clock_timestamp() + GREATEST fixes it: T1's write
    // is stamped with the real instant it actually runs (after T2 already committed), and the
    // upsert refuses to lower the stored value even if it weren't.
    const agent = await agentRepository.create(workspaceId, { name: "Interleaving Watermark Agent" });

    const clientA = await database.pool.connect();
    const clientB = await database.pool.connect();
    try {
      await clientA.query("BEGIN");
      await clientB.query("BEGIN");
      const dbA = createKyselyDatabase(asPool(clientA));
      const dbB = createKyselyDatabase(asPool(clientB));

      const olderDelayedWrite = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await touchAgentSkillsWatermark(dbA, workspaceId, agent.id);
        await clientA.query("COMMIT");
      })();

      // T1 (clientA) is asleep and has not touched the watermark row yet, so T2 (clientB) is free
      // to write and commit without blocking on any lock T1 holds.
      await touchAgentSkillsWatermark(dbB, workspaceId, agent.id);
      await clientB.query("COMMIT");
      const afterNewerCommit = await repository.latestUpdatedAt(workspaceId, agent.id);
      expect(afterNewerCommit).not.toBeNull();

      // Now let T1's delayed write land and commit.
      await olderDelayedWrite;

      const final = await repository.latestUpdatedAt(workspaceId, agent.id);
      expect(final).not.toBeNull();
      expect(final!.getTime()).toBeGreaterThanOrEqual(afterNewerCommit!.getTime());
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
