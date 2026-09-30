import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { createPostgresOwnershipReplyUnitOfWork } from "../../../src/app/composition/conversationOwnershipReplies.js";
import { createPostgresOwnershipChangeUnitOfWork } from "../../../src/app/composition/conversationOwnershipChanges.js";
import { ActionRequestRepository } from "../../../src/db/repositories/actionRequestRepository.js";
import { ConversationActivityRepository } from "../../../src/db/repositories/conversationActivityRepository.js";
import { ConversationOwnershipRepository } from "../../../src/db/repositories/conversationOwnershipRepository.js";
import type { ConversationRecord } from "../../../src/db/repositories/conversationRepository.js";
import { MessageRepository } from "../../../src/db/repositories/messageRepository.js";
import { CustomerReplyDeliveryDispatcher } from "../../../src/modules/customerReplyDelivery/public.js";
import {
  CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
  ConversationOwnershipService,
  OperatorReplyService,
  type OwnershipActor,
} from "../../../src/modules/handoff/public.js";
import { SlackCustomerReplyDeliverer } from "../../../src/modules/slack/public.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

// Real-Postgres checks of what ownership commits together: a transfer with the notice it owes the
// recipient (an outbox failure rolls the transfer back, and the drain push goes out only once both
// are durable), and a reply with the ownership it stands on and its delivery to the customer's
// channel (a transfer that commits first refuses the old owner's reply, a failed write leaves no
// claim or message behind, and nothing after the commit fails a reply that committed).

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("conversation transfer with its notice (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const ownership = new ConversationOwnershipRepository(database.kysely);
  const activity = new ConversationActivityRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const danaId = randomUUID();
  const foxId = randomUUID();
  const dana: OwnershipActor = { accountId, workspaceId, userId: danaId };

  const outboxRows = async (conversationId: string) => database.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM routine_action_requests WHERE conversation_id = $1`,
    [conversationId],
  );

  const messagesIn = async (conversationId: string) => database.query<{ content: string }>(
    `SELECT content FROM messages WHERE conversation_id = $1`,
    [conversationId],
  );

  const activityOf = async (conversationId: string) => database.query<{
    kind: string;
    actor_user_id: string | null;
    subject_user_id: string | null;
    detail: Record<string, unknown>;
  }>(
    `SELECT kind, actor_user_id, subject_user_id, detail FROM conversation_activity WHERE conversation_id = $1 ORDER BY created_at`,
    [conversationId],
  );

  const slackPostsFor = async (conversationId: string) => database.query<{ type: string; idempotency_key: string; payload: Record<string, unknown> }>(
    `SELECT type, idempotency_key, payload FROM routine_action_requests WHERE conversation_id = $1`,
    [conversationId],
  );

  // Conversations that came in over Slack; a reply to one is queued as a `slack.post`.
  const slackConversationIds = new Set<string>();
  const slackInstallation = {
    id: randomUUID(),
    connectionId: randomUUID(),
    workspaceId,
    accountId,
    teamId: "T1",
    teamName: "Acme",
    botUserId: "UBOT",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const conversationRecord = (id: string, inWorkspace: string): ConversationRecord => ({
    id,
    workspaceId: inWorkspace,
    ...(slackConversationIds.has(id)
      ? {
          sourceChannel: "slack",
          channelContext: {
            provider: "slack",
            team: { id: "T1", name: "Acme" },
            channel: { id: "D1", type: "im" },
            threadTs: "1700000000.000100",
            user: { id: "U1" },
          },
        }
      : { sourceChannel: null, channelContext: null }),
  }) as ConversationRecord;

  const createService = (
    actionDrain: { requestDrain: () => Promise<void> },
    options: { publish?: () => void } = {},
  ) => new ConversationOwnershipService({
    conversations: {
      findByIdAndWorkspaceId: async (id: string, inWorkspace: string) => conversationRecord(id, inWorkspace),
    },
    ownership,
    changes: createPostgresOwnershipChangeUnitOfWork({ db: database.kysely, activity, actionDrain, logger: { warn: vi.fn() } }),
    replyWrites: createPostgresOwnershipReplyUnitOfWork({ db: database.kysely, activity, actionDrain, logger: { warn: vi.fn() } }),
    operators: {
      find: async ({ userId }: { userId: string }) =>
        userId === foxId ? { userId: foxId, label: "Fox Mulder" } : userId === danaId ? { userId: danaId, label: "Dana Scully" } : null,
    },
    operatorIdentities: { resolve: async () => ({ userId: danaId, teammateLabel: "Dana Scully", replySignature: null }) },
    replies: new OperatorReplyService({
      auditService: { record: vi.fn(async () => undefined) },
      publicConversationEventBus: { publish: vi.fn(options.publish) },
      customerReplyDelivery: new CustomerReplyDeliveryDispatcher({
        slack: new SlackCustomerReplyDeliverer({
          installations: { findByTeamId: async () => slackInstallation, findById: async () => slackInstallation },
        }),
      }),
      logger: { warn: vi.fn() },
    }),
    audit: { record: vi.fn(async () => undefined) },
  });

  // Waits until some session in this database is blocked on a lock, i.e. the reply is queued behind
  // the uncommitted transfer; gives up after a few seconds so a reply that never waits fails its
  // assertions instead of hanging.
  const untilSomeoneWaitsOnALock = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await database.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (Number(waiting[0]?.waiting ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const seedClaimedConversation = async (options: { slack?: boolean } = {}): Promise<{ conversationId: string; version: number }> => {
    const conversationId = randomUUID();
    if (options.slack) {
      slackConversationIds.add(conversationId);
    }
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)`, [conversationId, workspaceId]);
    const claim = await ownership.takeOver({ conversationId, workspaceId, accountId, userId: danaId, displayName: "Dana Scully" });
    if (!claim.ok) {
      throw new Error("seed claim failed");
    }
    return { conversationId, version: claim.record.version };
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Transfer Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Transfer Workspace", `route-${workspaceId}`],
    );
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $6)`, [
      danaId, `dana-${danaId}@example.com`, "hash",
      foxId, `fox-${foxId}@example.com`, "hash",
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await database.query(`DELETE FROM routine_action_requests WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[danaId, foxId]]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("commits the transfer with its notice, then pushes a drain that finds the row", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const rowsSeenByDrain: unknown[][] = [];
    const service = createService({
      requestDrain: async () => {
        rowsSeenByDrain.push(await outboxRows(conversationId));
      },
    });

    const result = await service.transfer(dana, { conversationId, toUserId: foxId, expectedVersion: version });

    expect(result).toMatchObject({ ok: true, changed: true, record: { ownerUserId: foxId, version: version + 1 } });
    expect(rowsSeenByDrain).toEqual([[{
      type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
      payload: { recipientUserId: foxId, transferredByUserId: danaId, ownershipVersion: version + 1 },
    }]]);
  });

  it("rolls the transfer back when its notice cannot be queued", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const requestDrain = vi.fn(async () => undefined);
    vi.spyOn(ActionRequestRepository.prototype, "enqueue").mockRejectedValueOnce(new Error("outbox unavailable"));
    const service = createService({ requestDrain });

    await expect(service.transfer(dana, { conversationId, toUserId: foxId, expectedVersion: version }))
      .rejects.toThrow("outbox unavailable");

    await expect(ownership.load(conversationId)).resolves.toMatchObject({ ownerUserId: danaId, version });
    await expect(outboxRows(conversationId)).resolves.toEqual([]);
    expect(requestDrain).not.toHaveBeenCalled();
  });

  it("queues nothing and pushes no drain when a teammate takes the conversation themselves", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const requestDrain = vi.fn(async () => undefined);
    const service = createService({ requestDrain });

    const result = await service.transfer({ ...dana, userId: foxId }, { conversationId, toUserId: foxId, expectedVersion: version });

    expect(result).toMatchObject({ ok: true, changed: true, record: { ownerUserId: foxId } });
    await expect(outboxRows(conversationId)).resolves.toEqual([]);
    expect(requestDrain).not.toHaveBeenCalled();
  });

  it("refuses the old owner's reply when a transfer commits while the reply waits for the ownership", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const service = createService({ requestDrain: async () => undefined });
    let reply: ReturnType<typeof service.reply> | undefined;

    await database.kysely.transaction().execute(async (trx) => {
      // Fox takes the conversation; the transfer has written but not committed when Dana sends.
      const moved = await new ConversationOwnershipRepository(trx).transfer({
        conversationId, accountId, userId: foxId, displayName: "Fox Mulder", expectedVersion: version,
      });
      expect(moved.ok).toBe(true);
      reply = service.reply(dana, { conversationId, message: "Still here", expectedVersion: version });
      await untilSomeoneWaitsOnALock();
    });

    await expect(reply).resolves.toMatchObject({ ok: false, refusal: "held_by_teammate", record: { ownerUserId: foxId } });
    await expect(messagesIn(conversationId)).resolves.toEqual([]);
  });

  it("writes the owner's reply once nothing has moved the conversation", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const service = createService({ requestDrain: async () => undefined });

    const result = await service.reply(dana, { conversationId, message: "Hello", expectedVersion: version });

    expect(result).toMatchObject({ ok: true, record: { ownerUserId: danaId, version } });
    await expect(messagesIn(conversationId)).resolves.toEqual([{ content: "Hello" }]);
  });

  it("queues a Slack reply's post in the reply's transaction, keyed by the message, and pushes a drain that finds both", async () => {
    const { conversationId, version } = await seedClaimedConversation({ slack: true });
    const seenByDrain: unknown[] = [];
    const service = createService({
      requestDrain: async () => {
        seenByDrain.push({ messages: await messagesIn(conversationId), posts: await slackPostsFor(conversationId) });
      },
    });

    const result = await service.reply(dana, { conversationId, message: "On my way", expectedVersion: version });

    expect(result).toMatchObject({ ok: true });
    const messageId = result.ok ? result.message.id : "";
    expect(seenByDrain).toEqual([{
      messages: [{ content: "On my way" }],
      posts: [{
        type: "slack.post",
        idempotency_key: `slack:human_reply:${conversationId}:${messageId}`,
        payload: expect.objectContaining({ kind: "human_reply", channelId: "D1", threadTs: "1700000000.000100", text: "On my way" }),
      }],
    }]);
  });

  it("rolls the reply back when its Slack post cannot be queued, so sending it again delivers it once", async () => {
    const { conversationId, version } = await seedClaimedConversation({ slack: true });
    const requestDrain = vi.fn(async () => undefined);
    vi.spyOn(ActionRequestRepository.prototype, "enqueue").mockRejectedValueOnce(new Error("outbox unavailable"));
    const service = createService({ requestDrain });

    await expect(service.reply(dana, { conversationId, message: "On my way", expectedVersion: version }))
      .rejects.toThrow("outbox unavailable");
    await expect(messagesIn(conversationId)).resolves.toEqual([]);
    await expect(slackPostsFor(conversationId)).resolves.toEqual([]);
    expect(requestDrain).not.toHaveBeenCalled();

    const retried = await service.reply(dana, { conversationId, message: "On my way", expectedVersion: version });

    expect(retried).toMatchObject({ ok: true, record: { version } });
    await expect(messagesIn(conversationId)).resolves.toEqual([{ content: "On my way" }]);
    await expect(slackPostsFor(conversationId)).resolves.toHaveLength(1);
    expect(requestDrain).toHaveBeenCalledTimes(1);
  });

  it("answers a committed reply as sent when the push to the visitor or the drain push throws", async () => {
    const { conversationId, version } = await seedClaimedConversation({ slack: true });
    const service = createService(
      { requestDrain: async () => { throw new Error("drain transport down"); } },
      { publish: () => { throw new Error("listener failed"); } },
    );

    const result = await service.reply(dana, { conversationId, message: "On my way", expectedVersion: version });

    expect(result).toMatchObject({ ok: true, record: { ownerUserId: danaId, version } });
    await expect(messagesIn(conversationId)).resolves.toEqual([{ content: "On my way" }]);
    await expect(slackPostsFor(conversationId)).resolves.toHaveLength(1);
  });

  it("waits for a delete holding the conversation, then answers not found instead of writing", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const service = createService({ requestDrain: async () => undefined });
    let reply: ReturnType<typeof service.reply> | undefined;

    await database.kysely.transaction().execute(async (trx) => {
      // The conversation is deleted, and its ownership row with it, but not yet committed.
      await trx.deleteFrom("conversations").where("id", "=", conversationId).execute();
      reply = service.reply(dana, { conversationId, message: "Still here", expectedVersion: version });
      reply.catch(() => undefined);
      await untilSomeoneWaitsOnALock();
    });

    await expect(reply).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
    await expect(messagesIn(conversationId)).resolves.toEqual([]);
  });

  it("leaves no claim behind when the reply that would claim the conversation cannot be written", async () => {
    const conversationId = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)`, [conversationId, workspaceId]);
    vi.spyOn(MessageRepository.prototype, "create").mockRejectedValueOnce(new Error("messages unavailable"));
    const service = createService({ requestDrain: async () => undefined });

    await expect(service.reply(dana, { conversationId, message: "Hi", expectedVersion: 0 })).rejects.toThrow("messages unavailable");

    await expect(ownership.load(conversationId)).resolves.toBeNull();
    await expect(messagesIn(conversationId)).resolves.toEqual([]);
  });

  it("records each change with the teammate who made it: a claim, a reassignment from its holder, a hand-back", async () => {
    const conversationId = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)`, [conversationId, workspaceId]);
    const service = createService({ requestDrain: async () => undefined });

    const claimed = await service.takeOver(dana, { conversationId });
    const transferred = await service.transfer(dana, { conversationId, toUserId: foxId, expectedVersion: claimed.record!.version });
    await service.handBack({ ...dana, userId: foxId }, { conversationId, expectedVersion: transferred.record!.version });

    await expect(activityOf(conversationId)).resolves.toEqual([
      { kind: "claimed", actor_user_id: danaId, subject_user_id: null, detail: {} },
      { kind: "reassigned", actor_user_id: danaId, subject_user_id: foxId, detail: { fromUserId: danaId } },
      { kind: "handed_back", actor_user_id: foxId, subject_user_id: null, detail: {} },
    ]);
  });

  it("rolls a claim, a transfer, and a hand-back back when their activity cannot be recorded", async () => {
    const { conversationId, version } = await seedClaimedConversation();
    const service = createService({ requestDrain: async () => undefined });
    vi.spyOn(ConversationActivityRepository.prototype, "record").mockRejectedValue(new Error("activity unavailable"));

    await expect(service.transfer(dana, { conversationId, toUserId: foxId, expectedVersion: version }))
      .rejects.toThrow("activity unavailable");
    await expect(service.handBack(dana, { conversationId, expectedVersion: version }))
      .rejects.toThrow("activity unavailable");

    await expect(ownership.load(conversationId)).resolves.toMatchObject({ state: "human_owned", ownerUserId: danaId, version });
    await expect(outboxRows(conversationId)).resolves.toEqual([]);
    await expect(activityOf(conversationId)).resolves.toEqual([]);

    const unclaimed = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)`, [unclaimed, workspaceId]);
    await expect(service.takeOver(dana, { conversationId: unclaimed })).rejects.toThrow("activity unavailable");
    await expect(service.reply(dana, { conversationId: unclaimed, message: "Hi", expectedVersion: 0 }))
      .rejects.toThrow("activity unavailable");

    await expect(ownership.load(unclaimed)).resolves.toBeNull();
    await expect(messagesIn(unclaimed)).resolves.toEqual([]);
    await expect(activityOf(unclaimed)).resolves.toEqual([]);
  });
});
