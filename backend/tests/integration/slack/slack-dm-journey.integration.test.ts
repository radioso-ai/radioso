import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { type PoolClient, type QueryResultRow } from "pg";

import { OauthConnectionRepository } from "../../../src/db/repositories/oauthConnectionRepository.js";
import { IntegrationConnectionRepository } from "../../../src/modules/integrationConnections/public.js";
import {
  SlackChannelBindingRepository,
  SlackInstallationRepository,
  SlackInstallationService,
} from "../../../src/modules/slack/install/slackInstallationService.js";
import { SlackMessageHandler } from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";
import { PostgresSlackPersistence } from "../../../src/modules/connectors/plugins/slack/slackPersistence.js";
import type { Database } from "../../../src/shared/infra/database.js";
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

describeIfDatabase("Slack DM journey (postgres)", () => {
  const schema = `test_slack_dm_${randomUUID().replace(/-/g, "")}`;
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
    await client.query(`CREATE TABLE workspaces (id UUID PRIMARY KEY)`);
    await client.query(`CREATE TABLE agents (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL)`);
    await client.query(`
      CREATE TABLE conversations (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES workspaces(id),
        agent_id UUID REFERENCES agents(id),
        source_channel TEXT,
        source_origin TEXT,
        anonymous_session_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(await readFile(path.join(testMigrationsPath, "095_integration_oauth_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "105_integration_connections.sql"), "utf8"));
    await client.query(await readFile(path.join(testMigrationsPath, "107_slack_keystone.sql"), "utf8"));
    await client.query(`INSERT INTO workspaces (id) VALUES ($1)`, [workspaceId]);
    await client.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Slack Agent')`, [agentId, workspaceId]);
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client?.release();
    await pool?.end().catch(() => undefined);
  });

  it("creates a Slack conversation on first DM, posts a reply, and reuses it on the second DM", async () => {
    const oauthConnections = new OauthConnectionRepository(database);
    const integrationConnections = new IntegrationConnectionRepository(database);
    const installations = new SlackInstallationRepository(database);
    const bindings = new SlackChannelBindingRepository(database);
    const installationService = new SlackInstallationService({
      oauthConnections,
      integrationConnections,
      installations,
      bindings,
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

    const posts: Array<{ channel: string; text: string }> = [];
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
      persistence: new PostgresSlackPersistence(database),
      chat: {
        answer: async (input) => {
          chatInputs.push({
            ...(input.conversationId ? { conversationId: input.conversationId } : {}),
            sourceChannel: input.sourceChannel,
            query: input.query,
          });
          if (input.conversationId) {
            return { conversationId: input.conversationId, answer: `reply:${input.query}` };
          }
          const [row] = await database.query<{ id: string }>(
            `INSERT INTO conversations (id, workspace_id, agent_id, source_channel)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [randomUUID(), input.workspaceId, agentId, input.sourceChannel ?? null],
          );
          return { conversationId: row.id, answer: `reply:${input.query}` };
        },
      },
      clientFactory: () => ({
        postMessage: async (input) => {
          posts.push({ channel: input.channel, text: input.text });
          return { channel: input.channel, ts: "1720000000.000100" };
        },
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
});
