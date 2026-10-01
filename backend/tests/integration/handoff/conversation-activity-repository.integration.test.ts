import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createConversationActivityComposition } from "../../../src/app/composition/conversationActivity.js";
import { createTeammateLabelReader } from "../../../src/app/composition/teammateLabelReader.js";
import { ConversationActivityRepository } from "../../../src/db/repositories/conversationActivityRepository.js";
import { MessageRepository } from "../../../src/db/repositories/messageRepository.js";
import { UserRepository } from "../../../src/db/repositories/userRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

// Real-Postgres checks of the activity table: the reads the timeline and the Inbox's recently
// closed strip make, what the table refuses, and what deleting a user or a conversation does.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("conversation activity (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const activity = new ConversationActivityRepository(database.kysely);
  const labels = createTeammateLabelReader({ users: new UserRepository(database.kysely) });
  const reads = createConversationActivityComposition({
    store: activity,
    teammateLabels: labels,
    messages: new MessageRepository(database.kysely),
  }).reads;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const beaId = randomUUID();
  const carlId = randomUUID();

  const seedConversation = async (options: { sourceChannel?: string; title?: string } = {}): Promise<string> => {
    const conversationId = randomUUID();
    await database.query(
      `INSERT INTO conversations (id, workspace_id, source_channel, title) VALUES ($1, $2, $3, $4)`,
      [conversationId, workspaceId, options.sourceChannel ?? "embed", options.title ?? null],
    );
    return conversationId;
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Activity Co', $2, 'hash')`,
      [accountId, `activity-${accountId}@example.com`],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Activity', $3)`,
      [workspaceId, accountId, `activity-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'hash', 'Bea'), ($3, $4, 'hash', NULL)`,
      [beaId, `bea-${beaId}@example.com`, carlId, `carl-${carlId}@example.com`],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[beaId, carlId]]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("reads a conversation's timeline oldest first, each teammate labelled as they are now", async () => {
    const conversationId = await seedConversation();
    await activity.record(database.kysely, {
      kind: "handoff_requested", conversationId, workspaceId, actorUserId: null, detail: { reason: "retrieval_miss" },
    });
    await activity.record(database.kysely, {
      kind: "reassigned", conversationId, workspaceId, actorUserId: beaId, subjectUserId: carlId, detail: { fromUserId: null },
    });
    await database.query(`UPDATE users SET display_name = 'Carl' WHERE id = $1`, [carlId]);

    const read = await reads.readTimeline(workspaceId, conversationId, { includeFeedback: true });
    const timeline = read.present(await labels.labelsByUserIds(read.userIds));

    expect([...read.userIds].sort()).toEqual([beaId, carlId].sort());
    expect(Date.parse(read.cursor)).toBeGreaterThanOrEqual(Date.parse(timeline[1].createdAt));
    expect(timeline).toEqual([
      expect.objectContaining({ kind: "handoff_requested", actor: null, handoffReason: "retrieval_miss", subject: null }),
      expect.objectContaining({
        kind: "reassigned",
        actor: { userId: beaId, label: "Bea" },
        subject: { userId: carlId, label: "Carl" },
        from: null,
        handoffReason: null,
      }),
    ]);
    const foreignWorkspace = await reads.readTimeline(randomUUID(), conversationId, { includeFeedback: true });
    expect(foreignWorkspace.userIds).toEqual([]);
    expect(foreignWorkspace.present(new Map())).toEqual([]);
  });

  it("reads the events recorded after a time, only the kinds asked for, and when the read began", async () => {
    const conversationId = await seedConversation();
    await activity.record(database.kysely, { kind: "claimed", conversationId, workspaceId, actorUserId: beaId });
    await activity.record(database.kysely, {
      kind: "feedback_dismissed",
      conversationId,
      workspaceId,
      actorUserId: carlId,
      detail: { assistantMessageId: randomUUID(), triageTransitionId: randomUUID(), resolution: null },
    });
    const { records: [claimed, dismissed] } = await activity.listForConversation(workspaceId, conversationId, {
      kinds: ["claimed", "feedback_dismissed"],
    });
    await activity.record(database.kysely, { kind: "handed_back", conversationId, workspaceId, actorUserId: beaId });
    const withoutFeedback = ["claimed", "handed_back"] as const;

    // A Date holds milliseconds and the column microseconds: a millisecond on is past the event.
    const justAfter = (record: { createdAt: Date }) => new Date(record.createdAt.getTime() + 1);
    const afterClaimed = await activity.listForConversation(workspaceId, conversationId, {
      kinds: withoutFeedback,
      recordedAfter: justAfter(claimed),
    });
    const afterDismissed = await activity.listForConversation(workspaceId, conversationId, {
      kinds: withoutFeedback,
      recordedAfter: justAfter(dismissed),
    });
    const none = await activity.listForConversation(workspaceId, conversationId, { kinds: [] });

    expect(afterClaimed.records.map((record) => record.kind)).toEqual(["handed_back"]);
    expect(afterDismissed.records.map((record) => record.kind)).toEqual(["handed_back"]);
    expect(afterClaimed.readAt.getTime()).toBeGreaterThanOrEqual(afterClaimed.records[0].createdAt.getTime());
    expect(none.records).toEqual([]);
  });

  it("hands the next tail an event that commits after a newer one, though written before it", async () => {
    const conversationId = await seedConversation();
    const scope = { includeFeedback: false };
    const kinds = (timeline: { present(labels: ReadonlyMap<string, string>): Array<{ kind: string }> }) =>
      timeline.present(new Map()).map((entry) => entry.kind);

    // The approval's transaction writes its event first and commits last, as a resume turn does.
    const first = await database.kysely.transaction().execute(async (transaction) => {
      await activity.record(transaction, {
        kind: "approval_decided",
        conversationId,
        workspaceId,
        actorUserId: beaId,
        detail: { handle: "handle-1", decision: { optionId: "approve", label: "Approve" } },
      });
      await activity.record(database.kysely, { kind: "claimed", conversationId, workspaceId, actorUserId: carlId });
      return reads.readTimeline(workspaceId, conversationId, scope);
    });
    const next = await reads.readTimeline(workspaceId, conversationId, { ...scope, after: first.cursor });

    expect(kinds(first)).toEqual(["claimed"]);
    expect(kinds(next)).toEqual(["approval_decided", "claimed"]);
  });

  it("reads past a cursor from another conversation, and nothing older than the window behind a cursor", async () => {
    const conversationId = await seedConversation();
    const other = await seedConversation();
    await activity.record(database.kysely, { kind: "claimed", conversationId, workspaceId, actorUserId: beaId });
    await database.query(
      `UPDATE conversation_activity SET created_at = now() - interval '1 hour' WHERE conversation_id = $1`,
      [conversationId],
    );
    const foreign = await reads.readTimeline(workspaceId, other, { includeFeedback: false });
    const idle = await reads.readTimeline(workspaceId, conversationId, { includeFeedback: false, after: foreign.cursor });
    await activity.record(database.kysely, { kind: "handed_back", conversationId, workspaceId, actorUserId: beaId });

    const next = await reads.readTimeline(workspaceId, conversationId, { includeFeedback: false, after: foreign.cursor });

    expect(idle.present(new Map())).toEqual([]);
    expect(idle.userIds).toEqual([]);
    expect(next.present(new Map()).map((entry) => entry.kind)).toEqual(["handed_back"]);
  });

  it("lists the workspace's latest closing events with the conversation's title or preview, leaving out test chats", async () => {
    const titled = await seedConversation({ title: "Refund for order 1042" });
    const untitled = await seedConversation();
    await database.query(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ($1, $2, $3, 'user', 'Where is my parcel?')`,
      [randomUUID(), untitled, workspaceId],
    );
    const testChat = await seedConversation({ sourceChannel: "authenticated_chat" });
    await activity.record(database.kysely, { kind: "claimed", conversationId: titled, workspaceId, actorUserId: beaId });
    await activity.record(database.kysely, { kind: "handed_back", conversationId: titled, workspaceId, actorUserId: beaId });
    await activity.record(database.kysely, {
      kind: "approval_decided",
      conversationId: untitled,
      workspaceId,
      actorUserId: carlId,
      detail: { handle: "decision_1", decision: { optionId: "approve", label: "Approve refund" } },
    });
    await activity.record(database.kysely, { kind: "handed_back", conversationId: testChat, workspaceId, actorUserId: beaId });

    const closed = await reads.listRecentlyClosed(workspaceId, 10, { includeFeedback: true });

    expect(closed.filter((item) => [titled, untitled, testChat].includes(item.conversationId))).toEqual([
      expect.objectContaining({
        conversationId: untitled,
        itemKind: "approval",
        outcome: "approval_decided",
        closedBy: { userId: carlId, label: expect.any(String) },
        decision: { optionId: "approve", label: "Approve refund" },
        title: null,
        preview: "Where is my parcel?",
      }),
      expect.objectContaining({
        conversationId: titled,
        itemKind: "handoff",
        outcome: "handed_back",
        closedBy: { userId: beaId, label: "Bea" },
        title: "Refund for order 1042",
      }),
    ]);
    await expect(reads.listRecentlyClosed(workspaceId, 1, { includeFeedback: true })).resolves.toHaveLength(1);
  });

  it("leaves feedback outcomes out of recently closed for a scope without them, still filling the limit", async () => {
    const isolatedWorkspace = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Activity scope', $3)`,
      [isolatedWorkspace, accountId, `activity-${isolatedWorkspace}`],
    );
    const conversationId = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id, source_channel) VALUES ($1, $2, 'embed')`, [conversationId, isolatedWorkspace]);
    const scope = { conversationId, workspaceId: isolatedWorkspace };
    await activity.record(database.kysely, { ...scope, kind: "handed_back", actorUserId: beaId });
    await activity.record(database.kysely, {
      ...scope,
      kind: "feedback_resolved",
      actorUserId: carlId,
      detail: { assistantMessageId: randomUUID(), triageTransitionId: randomUUID(), resolution: "knowledge_gap" },
    });

    const withoutFeedback = await reads.listRecentlyClosed(isolatedWorkspace, 1, { includeFeedback: false });
    const withFeedback = await reads.listRecentlyClosed(isolatedWorkspace, 1, { includeFeedback: true });

    expect(withoutFeedback.map((item) => item.outcome)).toEqual(["handed_back"]);
    expect(withFeedback.map((item) => item.outcome)).toEqual(["feedback_resolved"]);
  });

  it("refuses an unknown kind and a detail that is not an object", async () => {
    const conversationId = await seedConversation();

    await expect(database.query(
      `INSERT INTO conversation_activity (conversation_id, workspace_id, kind) VALUES ($1, $2, 'replied')`,
      [conversationId, workspaceId],
    )).rejects.toThrow(/check constraint/);
    await expect(database.query(
      `INSERT INTO conversation_activity (conversation_id, workspace_id, kind, detail) VALUES ($1, $2, 'claimed', '[]')`,
      [conversationId, workspaceId],
    )).rejects.toThrow(/check constraint/);
  });

  it("keeps an event when its teammate's user is deleted, and drops it with its conversation", async () => {
    const conversationId = await seedConversation();
    const leaverId = randomUUID();
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')`, [leaverId, `leaver-${leaverId}@example.com`]);
    await activity.record(database.kysely, { kind: "handed_back", conversationId, workspaceId, actorUserId: leaverId });

    await database.query(`DELETE FROM users WHERE id = $1`, [leaverId]);
    await expect(activity.listForConversation(workspaceId, conversationId, { kinds: ["handed_back"] })).resolves.toMatchObject({
      records: [expect.objectContaining({ kind: "handed_back", actorUserId: null })],
    });

    await database.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
    await expect(activity.listForConversation(workspaceId, conversationId, { kinds: ["handed_back"] }))
      .resolves.toMatchObject({ records: [] });
  });
});
