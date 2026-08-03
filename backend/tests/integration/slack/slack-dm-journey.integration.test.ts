import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient, type QueryResultRow } from "pg";

import { OauthConnectionRepository } from "../../../src/db/repositories/oauthConnectionRepository.js";
import { ActionRequestRepository } from "../../../src/db/repositories/actionRequestRepository.js";
import { IntegrationConnectionRepository } from "../../../src/modules/integrationConnections/public.js";
import {
  SlackChannelBindingRepository,
  SlackInstallationRepository,
  SlackInstallationService,
  PostgresWorkspaceAccountLookup,
} from "../../../src/modules/slack/install/slackInstallationService.js";
import { SlackMessageHandler } from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";
import { PostgresSlackPersistence } from "../../../src/modules/connectors/plugins/slack/slackPersistence.js";
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
  // Single-client pool so Kysely (used by the migrated Oauth/ActionRequest repos) shares the
  // test transaction with the raw-SQL repos that still call query()/execute() on this shim.
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
    async queryOptional<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
      return (await client.query<T>(text, params)).rows[0] ?? null;
    },
    async queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
      const row = (await client.query<T>(text, params)).rows[0];
      if (!row) throw new Error("Expected query to return one row");
      return row;
    },
    async execute(text: string, params: unknown[] = []): Promise<number> {
      return (await client.query(text, params)).rowCount ?? 0;
    },
  } as Database;
};

describeIfDatabase("Slack DM journey (postgres)", () => {
  const schema = `test_slack_dm_${randomUUID().replace(/-/g, "")}`;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const encryptionKey = Buffer.alloc(32, 9).toString("base64");

  let pool: pg.Pool;
  let client: PoolClient;
  let database: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    client = await pool.connect();
    database = clientBackedDatabase(client);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE accounts (id UUID PRIMARY KEY)`);
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY, account_id UUID NOT NULL)`);
    await client.query(`CREATE TABLE agents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL)`);
    // Mirrors the real conversations table; add any column ConversationRepository reads or writes.
    await client.query(`
      CREATE TABLE conversations (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES workspaces(id),
        agent_id UUID REFERENCES agents(id),
        source_channel TEXT,
        source_origin TEXT,
        entry_page_url TEXT,
        channel_context JSONB,
        anonymous_session_id TEXT,
        verified_customer_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(await readFile(path.join(testMigrationsPath, "095_integration_oauth_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "105_integration_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "107_slack_keystone.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "112_slack_gap_escalation_optin.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "116_slack_channel_scoped_bindings.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "117_integration_connections_account_owner.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "118_slack_installation_account_authoritative.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "072_routine_action_requests.sql"), "utf8"));
    await client.query(`INSERT INTO accounts (id) VALUES ($1)`, [accountId]);
    await client.query(`INSERT INTO workspaces (id, account_id) VALUES ($1, $2)`, [workspaceId, accountId]);
    await client.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Slack Agent')`, [agentId, workspaceId]);
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("creates a Slack conversation on first DM, posts a reply, and reuses it on the second DM", async () => {
    const oauthConnections = new OauthConnectionRepository(database.kysely);
    const integrationConnections = new IntegrationConnectionRepository(database.kysely);
    const installations = new SlackInstallationRepository(database.kysely);
    const bindings = new SlackChannelBindingRepository(database.kysely);
    const installationService = new SlackInstallationService({
      oauthConnections,
      integrationConnections,
      installations,
      bindings,
      workspaceAccounts: new PostgresWorkspaceAccountLookup(database.kysely),
      encryptionKey,
    });
    const saved = await installationService.saveInstallation({
      workspaceId,
      teamId: "TDM",
      teamName: "DM Team",
      botUserId: "UBOT",
      botAccessToken: "xoxb-dm-token",
      grantedScopes: ["chat:write", "im:read"],
      answeringAgentId: agentId,
    });
    expect(saved.binding?.answeringAgentId).toBe(agentId);

    const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
    const chatInputs: Array<{ conversationId?: string; sourceChannel?: string | null; query: string }> = [];
    const handler = new SlackMessageHandler({
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      installations,
      bindings,
      installationService,
      persistence: new PostgresSlackPersistence(database.kysely),
      chat: {
        answer: async (input) => {
          chatInputs.push({
            ...(input.conversationId ? { conversationId: input.conversationId } : {}),
            sourceChannel: input.sourceChannel,
            query: input.query,
          });
          if (input.conversationId) {
            return { conversationId: input.conversationId, answer: `reply:${input.query}`, outcome: "answered" };
          }
          const [row] = await database.query<{ id: string }>(
            `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [randomUUID(), input.workspaceId, agentId, input.sourceChannel ?? null],
          );
          return { conversationId: row.id, answer: `reply:${input.query}`, outcome: "answered" };
        },
      },
      clientFactory: () => ({
        postMessage: async (input) => {
          posts.push({
            channel: input.channel,
            text: input.text,
            ...(input.threadTs ? { threadTs: input.threadTs } : {}),
          });
          return { channel: input.channel, ts: "1720000000.000100" };
        },
        addReaction: async () => undefined,
        removeReaction: async () => undefined,
      }),
    });

    await database.query(
      `INSERT INTO slack_inbound_events (event_id, team_id, status) VALUES ('EvOne', 'TDM', 'received')`,
    );
    await handler.handleMessageIm({
      eventId: "EvOne",
      teamId: "TDM",
      event: {
        type: "message",
        channel_type: "im",
        channel: "DUSER",
        user: "UUSER",
        text: "first question",
      },
    });

    const [link] = await database.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM slack_conversation_links WHERE slack_key = 'dm:TDM:UUSER'`,
    );
    expect(link?.conversation_id).toBeTruthy();
    const [conversation] = await database.query<{ source_channel: string | null }>(
      `SELECT source_channel FROM conversations WHERE id = $1`,
      [link.conversation_id],
    );
    expect(conversation.source_channel).toBe("slack");
    expect(posts).toEqual([{ channel: "DUSER", text: "reply:first question" }]);

    await database.query(
      `INSERT INTO slack_inbound_events (event_id, team_id, status) VALUES ('EvTwo', 'TDM', 'received')`,
    );
    await handler.handleMessageIm({
      eventId: "EvTwo",
      teamId: "TDM",
      event: {
        type: "message",
        channel_type: "im",
        channel: "DUSER",
        user: "UUSER",
        text: "follow up",
      },
    });

    expect(chatInputs[1]).toMatchObject({ conversationId: link.conversation_id, sourceChannel: "slack", query: "follow up" });
    const links = await database.query(`SELECT id FROM slack_conversation_links WHERE slack_key = 'dm:TDM:UUSER'`);
    expect(links).toHaveLength(1);
    expect(posts.at(-1)).toEqual({ channel: "DUSER", text: "reply:follow up" });
  });

  it("maps a channel mention thread to one conversation and escalates no-context mention turns", async () => {
    const oauthConnections = new OauthConnectionRepository(database.kysely);
    const integrationConnections = new IntegrationConnectionRepository(database.kysely);
    const installations = new SlackInstallationRepository(database.kysely);
    const bindings = new SlackChannelBindingRepository(database.kysely);
    const installationService = new SlackInstallationService({
      oauthConnections,
      integrationConnections,
      installations,
      bindings,
      workspaceAccounts: new PostgresWorkspaceAccountLookup(database.kysely),
      encryptionKey,
    });
    const saved = await installationService.saveInstallation({
      workspaceId,
      teamId: "TMENTION",
      teamName: "Mention Team",
      botUserId: "UBOT",
      botAccessToken: "xoxb-mention-token",
      grantedScopes: ["app_mentions:read", "chat:write", "im:read", "im:write"],
      answeringAgentId: agentId,
      escalationChannelId: "CSUPPORT",
      gapEscalationEnabled: true,
    });

    const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
    const chatInputs: Array<{ conversationId?: string; sourceChannel?: string | null; query: string }> = [];
    let nextOutcome: "answered" | "no_context" = "answered";
    const handler = new SlackMessageHandler({
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      installations,
      bindings,
      installationService,
      persistence: new PostgresSlackPersistence(database.kysely),
      slackPostOutbox: new ActionRequestRepository(database.kysely),
      chat: {
        answer: async (input) => {
          chatInputs.push({
            ...(input.conversationId ? { conversationId: input.conversationId } : {}),
            sourceChannel: input.sourceChannel,
            query: input.query,
          });
          if (input.conversationId) {
            return {
              conversationId: input.conversationId,
              answer: `mention:${input.query}`,
              outcome: nextOutcome,
            };
          }
          const [row] = await database.query<{ id: string }>(
            `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [randomUUID(), input.workspaceId, agentId, input.sourceChannel ?? null],
          );
          return { conversationId: row.id, answer: `mention:${input.query}`, outcome: nextOutcome };
        },
      },
      clientFactory: () => ({
        postMessage: async (input) => {
          posts.push({
            channel: input.channel,
            text: input.text,
            ...(input.threadTs ? { threadTs: input.threadTs } : {}),
          });
          return { channel: input.channel, ts: "1720000000.000300" };
        },
        addReaction: async () => undefined,
        removeReaction: async () => undefined,
      }),
    });

    await database.query(
      `INSERT INTO slack_inbound_events (event_id, team_id, status) VALUES ('EvMentionOne', 'TMENTION', 'received')`,
    );
    await handler.handleAppMention({
      eventId: "EvMentionOne",
      teamId: "TMENTION",
      event: {
        type: "app_mention",
        channel: "CCHANNEL",
        user: "UUSER",
        text: "<@UBOT> first mention",
        ts: "1700000000.000100",
      },
    });

    const [link] = await database.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM slack_conversation_links WHERE slack_key = 'mention:TMENTION:CCHANNEL:1700000000.000100'`,
    );
    expect(link?.conversation_id).toBeTruthy();
    expect(posts.at(-1)).toEqual({
      channel: "CCHANNEL",
      text: "mention:<@UBOT> first mention",
      threadTs: "1700000000.000100",
    });

    nextOutcome = "no_context";
    await database.query(
      `INSERT INTO slack_inbound_events (event_id, team_id, status) VALUES ('EvMentionTwo', 'TMENTION', 'received')`,
    );
    await handler.handleAppMention({
      eventId: "EvMentionTwo",
      teamId: "TMENTION",
      event: {
        type: "app_mention",
        channel: "CCHANNEL",
        user: "UUSER",
        text: "<@UBOT> missing follow up",
        thread_ts: "1700000000.000100",
        ts: "1700000001.000100",
      },
    });

    expect(chatInputs[1]).toMatchObject({
      conversationId: link.conversation_id,
      sourceChannel: "slack",
      query: "<@UBOT> missing follow up",
    });
    const links = await database.query(
      `SELECT id FROM slack_conversation_links WHERE slack_key = 'mention:TMENTION:CCHANNEL:1700000000.000100'`,
    );
    expect(links).toHaveLength(1);
    expect(posts.at(-1)).toEqual({
      channel: "CCHANNEL",
      text: "mention:<@UBOT> missing follow up",
      threadTs: "1700000000.000100",
    });

    const gapRows = await database.query<{ payload: { kind: string; installationId: string; channelId: string } }>(
      `SELECT payload FROM routine_action_requests WHERE idempotency_key LIKE 'slack:gap_escalation:EvMentionTwo:%'`,
    );
    expect(gapRows).toHaveLength(1);
    expect(gapRows[0]?.payload).toMatchObject({
      kind: "gap_escalation",
      installationId: saved.installation.id,
      channelId: "CSUPPORT",
    });
  });

  it("enqueues a gap escalation from a typed no_context outcome and skips grounded turns", async () => {
    const oauthConnections = new OauthConnectionRepository(database.kysely);
    const integrationConnections = new IntegrationConnectionRepository(database.kysely);
    const installations = new SlackInstallationRepository(database.kysely);
    const bindings = new SlackChannelBindingRepository(database.kysely);
    const installationService = new SlackInstallationService({
      oauthConnections,
      integrationConnections,
      installations,
      bindings,
      workspaceAccounts: new PostgresWorkspaceAccountLookup(database.kysely),
      encryptionKey,
    });
    const saved = await installationService.saveInstallation({
      workspaceId,
      teamId: "TGAP",
      teamName: "Gap Team",
      botUserId: "UBOT",
      botAccessToken: "xoxb-gap-token",
      grantedScopes: ["chat:write", "im:read"],
      answeringAgentId: agentId,
      escalationChannelId: "CSUPPORT",
      gapEscalationEnabled: true,
    });

    let nextOutcome: "answered" | "no_context" = "no_context";
    const handler = new SlackMessageHandler({
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      installations,
      bindings,
      installationService,
      persistence: new PostgresSlackPersistence(database.kysely),
      slackPostOutbox: new ActionRequestRepository(database.kysely),
      chat: {
        answer: async (input) => {
          const [row] = await database.query<{ id: string }>(
            `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [randomUUID(), input.workspaceId, agentId, input.sourceChannel ?? null],
          );
          return {
            conversationId: row.id,
            answer: nextOutcome === "no_context" ? "Generated refusal" : "Grounded answer",
            outcome: nextOutcome,
          };
        },
      },
      clientFactory: () => ({
        postMessage: async (input) => ({ channel: input.channel, ts: "1720000000.000200" }),
        addReaction: async () => undefined,
        removeReaction: async () => undefined,
      }),
    });

    await database.query(
      `INSERT INTO slack_inbound_events (event_id, team_id, status) VALUES ('EvGap', 'TGAP', 'received')`,
    );
    await handler.handleMessageIm({
      eventId: "EvGap",
      teamId: "TGAP",
      event: {
        type: "message",
        channel_type: "im",
        channel: "DGAP",
        user: "UGAP",
        text: "missing thing",
      },
    });

    const gapRows = await database.query<{ type: string; payload: { kind: string; installationId: string; channelId: string } }>(
      `SELECT type, payload FROM routine_action_requests WHERE idempotency_key LIKE 'slack:gap_escalation:EvGap:%'`,
    );
    expect(gapRows).toHaveLength(1);
    expect(gapRows[0]).toMatchObject({
      type: "slack.post",
      payload: {
        kind: "gap_escalation",
        installationId: saved.installation.id,
        channelId: "CSUPPORT",
      },
    });

    nextOutcome = "answered";
    await database.query(
      `INSERT INTO slack_inbound_events (event_id, team_id, status) VALUES ('EvGrounded', 'TGAP', 'received')`,
    );
    await handler.handleMessageIm({
      eventId: "EvGrounded",
      teamId: "TGAP",
      event: {
        type: "message",
        channel_type: "im",
        channel: "DGAP",
        user: "UOTHER",
        text: "covered thing",
      },
    });

    const groundedRows = await database.query(
      `SELECT id FROM routine_action_requests WHERE idempotency_key LIKE 'slack:gap_escalation:EvGrounded:%'`,
    );
    expect(groundedRows).toHaveLength(0);
  });
});
