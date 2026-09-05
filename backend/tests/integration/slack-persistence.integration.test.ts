import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresSlackPersistence } from "../../src/modules/connectors/plugins/slack/slackPersistence.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of PostgresSlackPersistence after the Kysely migration.
// Covers the inbound-event dedup/lifecycle (no FK) and the conversation-link upsert
// (FK-heavy: workspace + installation + conversation). Behaviour here is the spec the
// Kysely rewrite must preserve.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("PostgresSlackPersistence (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const persistence = new PostgresSlackPersistence(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const installationId = randomUUID();
  const connectionId = randomUUID();
  const oauthConnectionId = randomUUID();
  const conversationIdA = randomUUID();
  const conversationIdB = randomUUID();
  const teamId = `T-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Slack Persistence Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Slack WS", `route-${workspaceId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`,
      [agentId, workspaceId, "Slack Agent"],
    );
    await database.query(
      `INSERT INTO conversations (id, workspace_id) VALUES ($1, $2), ($3, $2)`,
      [conversationIdA, workspaceId, conversationIdB],
    );
    // integration_connections + slack_installations are the FK parents of conversation links.
    await database.query(
      `INSERT INTO integration_oauth_connections (id, workspace_id, provider, display_name, status)
       VALUES ($1, $2, 'slack', 'Slack OAuth', 'authorized')`,
      [oauthConnectionId, workspaceId],
    );
    await database.query(
      `INSERT INTO integration_connections (id, workspace_id, oauth_connection_id, provider, display_name, status)
       VALUES ($1, $2, $3, 'slack', 'Slack', 'authorized')`,
      [connectionId, workspaceId, oauthConnectionId],
    );
    await database.query(
      `INSERT INTO slack_installations (id, connection_id, workspace_id, account_id, team_id, bot_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [installationId, connectionId, workspaceId, accountId, teamId, "U-bot"],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM slack_inbound_events WHERE team_id = $1`, [teamId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("creates an inbound event once and dedups on the event_id conflict", async () => {
    const eventId = `E-${randomUUID()}`;

    const first = await persistence.createInboundEvent({ eventId, teamId });
    const second = await persistence.createInboundEvent({ eventId, teamId });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("marks an inbound event status", async () => {
    const eventId = `E-${randomUUID()}`;
    await persistence.createInboundEvent({ eventId, teamId });

    await persistence.markInboundEventStatus(eventId, "processed");

    const [row] = await database.query<{ status: string }>(
      `SELECT status FROM slack_inbound_events WHERE event_id = $1`,
      [eventId],
    );
    expect(row?.status).toBe("processed");
  });

  it("fails only stale received events and returns the count", async () => {
    const staleId = `E-${randomUUID()}`;
    const freshId = `E-${randomUUID()}`;
    await persistence.createInboundEvent({ eventId: staleId, teamId });
    await persistence.createInboundEvent({ eventId: freshId, teamId });
    // Backdate one event's received_at so it falls before the olderThan threshold.
    await database.query(
      `UPDATE slack_inbound_events SET received_at = NOW() - interval '1 hour' WHERE event_id = $1`,
      [staleId],
    );

    const failed = await persistence.markStaleInboundEventsFailed({
      olderThan: new Date(Date.now() - 60_000),
    });

    expect(failed).toBeGreaterThanOrEqual(1);
    const [stale] = await database.query<{ status: string }>(
      `SELECT status FROM slack_inbound_events WHERE event_id = $1`,
      [staleId],
    );
    const [fresh] = await database.query<{ status: string }>(
      `SELECT status FROM slack_inbound_events WHERE event_id = $1`,
      [freshId],
    );
    expect(stale?.status).toBe("failed");
    expect(fresh?.status).toBe("received");
  });

  it("returns null for a missing conversation link", async () => {
    const link = await persistence.findConversationLink({ workspaceId, slackKey: `missing-${randomUUID()}` });
    expect(link).toBeNull();
  });

  it("atomically creates one linked conversation for concurrent first events", async () => {
    const slackKey = `${teamId}:DM:${randomUUID().slice(0, 6)}`;
    const input = {
      workspaceId,
      installationId,
      slackKey,
      agentId,
      sourceChannel: "slack" as const,
      channelContext: {
        provider: "slack" as const,
        team: { id: teamId },
        channel: { id: "D-CONCURRENT", type: "im" as const },
        user: { id: "U-CONCURRENT" },
      },
    };

    const [first, second] = await Promise.all([
      persistence.getOrCreateConversationLink(input),
      persistence.getOrCreateConversationLink(input),
    ]);

    expect(first.link.conversationId).toBe(second.link.conversationId);
    const conversations = await database.query<{ id: string }>(
      `SELECT id FROM conversations WHERE workspace_id = $1 AND source_channel = 'slack'`,
      [workspaceId],
    );
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe(first.link.conversationId);
    const links = await database.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM slack_conversation_links WHERE slack_key = $1`,
      [slackKey],
    );
    expect(links).toEqual([{ conversation_id: first.link.conversationId }]);

    expect([first.created, second.created].sort()).toEqual([false, true]);
  });

  it("upserts a conversation link on the slack_key conflict, updating conversation + installation", async () => {
    const slackKey = `${teamId}:C123:${randomUUID().slice(0, 6)}`;

    const created = await persistence.upsertConversationLink({
      workspaceId,
      installationId,
      slackKey,
      conversationId: conversationIdA,
    });
    expect(created.slackKey).toBe(slackKey);
    expect(created.conversationId).toBe(conversationIdA);

    const updated = await persistence.upsertConversationLink({
      workspaceId,
      installationId,
      slackKey,
      conversationId: conversationIdB,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.conversationId).toBe(conversationIdB);

    const found = await persistence.findConversationLink({ workspaceId, slackKey });
    expect(found?.conversationId).toBe(conversationIdB);
  });
});
