import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { VOICE_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import { decodeCursorWithKeys, encodeCursor } from "../../src/shared/domain/cursorPagination.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Characterization for MessageRepository against Postgres. Covers behavior the deleted
// SQL-string mock unit tests asserted (source derivation, operator-provenance metadata,
// nested metadata round-trip) plus cursor windowing and conversation summaries.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("MessageRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new MessageRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Msg Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Msg Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)`, [conversationId, workspaceId]);
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const setTime = (id: string, iso: string) =>
    database.query(`UPDATE messages SET created_at = $2::timestamptz WHERE id = $1`, [id, iso]);

  it("derives source from role and persists explicit source + operator metadata", async () => {
    const ai = await repository.create({ conversationId, workspaceId, role: "assistant", content: "Done." });
    expect(ai.source).toBe("ai_agent");

    const human = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      source: "human_agent",
      content: "A human answered.",
      operatorAccountId: "account-1",
      operatorDisplayName: "Dana Operator",
    });
    expect(human.source).toBe("human_agent");
    expect(human.metadata).toEqual({ humanAgent: { accountId: "account-1", displayName: "Dana Operator" } });
  });

  it("deletes one user message of the conversation and nothing else", async () => {
    const otherConversationId = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)`, [otherConversationId, workspaceId]);
    const kept = await repository.create({ conversationId, workspaceId, role: "user", content: "When do you open?" });
    const replaced = await repository.create({ conversationId, workspaceId, role: "user", content: "When do you op" });
    const reply = await repository.create({ conversationId, workspaceId, role: "assistant", content: "At nine." });

    expect(await repository.deleteUserMessage({ workspaceId, conversationId, messageId: replaced.id })).toBe(true);
    expect(await repository.deleteUserMessage({ workspaceId, conversationId, messageId: replaced.id })).toBe(false);
    expect(await repository.deleteUserMessage({ workspaceId, conversationId, messageId: reply.id })).toBe(false);
    expect(await repository.deleteUserMessage({ workspaceId, conversationId: otherConversationId, messageId: kept.id })).toBe(false);
    expect((await repository.listByConversationId(workspaceId, conversationId)).map((message) => message.id)).toEqual([kept.id, reply.id]);
  });

  it("round-trips nested metadata through jsonb", async () => {
    const nested = { activityTrace: { traceId: "t1", stages: [{ kind: "intake", outputs: { nested: { a: [1, 2] } } }] } };
    const created = await repository.create({ conversationId, workspaceId, role: "assistant", content: "x", metadata: nested });
    const reloaded = (await repository.listByConversationId(workspaceId, conversationId)).find((m) => m.id === created.id);
    expect(reloaded?.metadata).toEqual(nested);
  });

  it("round-trips a routine invocation's input metadata and drops an unknown input method on read", async () => {
    const invocation = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: 'start_return {"orderId":"A-1001","reason":"Wrong size"}',
      inputMetadata: {
        method: "routine_invocation",
        routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
      },
    });
    const unknownMethod = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: "hi",
      metadata: { method: "voice_note", routine: { toolName: "start_return", input: {} } },
    });

    const reloaded = await repository.listByConversationId(workspaceId, conversationId);
    expect(reloaded.find((m) => m.id === invocation.id)?.inputMetadata).toEqual({
      method: "routine_invocation",
      routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
    });
    expect(reloaded.find((m) => m.id === unknownMethod.id)?.inputMetadata).toBeUndefined();
  });

  it("marks an assistant reply the caller cut short, keeping the reply's other metadata", async () => {
    const suggestions = [{ kind: "question", label: "Opening hours?" }];
    const reply = await repository.create({ conversationId, workspaceId, role: "assistant", content: "We open at nine.", metadata: { suggestions } });

    await expect(repository.markReplyInterrupted({ workspaceId, conversationId, messageId: reply.id, heardCharacterCount: 7, spokenCharacterCount: 16 }))
      .resolves.toBe(true);

    const reloaded = await repository.findByIdAndWorkspaceId(workspaceId, reply.id);
    expect(reloaded?.content).toBe("We open at nine.");
    expect(reloaded?.interruption).toEqual({ heardCharacterCount: 7, spokenCharacterCount: 16, partial: false });
    expect(reloaded?.metadata).toMatchObject({
      suggestions,
      interruption: { heardCharacterCount: 7, spokenCharacterCount: 16, recordedAt: expect.any(String) },
    });
  });

  // The first report wins whole: a retried note, or a later report with other counts, changes neither
  // the counts nor the time the marker was recorded.
  it("keeps the first marker whole when the reply is marked again, with the same counts or others", async () => {
    const reply = await repository.create({ conversationId, workspaceId, role: "assistant", content: "We open at nine." });
    const mark = (heardCharacterCount: number) =>
      repository.markReplyInterrupted({ workspaceId, conversationId, messageId: reply.id, heardCharacterCount, spokenCharacterCount: 16 });
    const storedMarker = async () =>
      (await repository.findByIdAndWorkspaceId(workspaceId, reply.id))?.metadata?.interruption as { heardCharacterCount: number; recordedAt: string };

    await expect(mark(7)).resolves.toBe(true);
    const first = await storedMarker();
    expect(first).toMatchObject({ heardCharacterCount: 7, recordedAt: expect.any(String) });
    // Still marked, so a retried note goes on to its audit event.
    await expect(mark(7)).resolves.toBe(true);
    expect(await storedMarker()).toEqual(first);

    await expect(mark(9)).resolves.toBe(true);
    expect(await storedMarker()).toEqual(first);
  });

  it("stores a reply already cut short with its marker, which no later mark changes", async () => {
    const reply = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "We open at nine.",
      interruption: { heardCharacterCount: 16, spokenCharacterCount: 16, partial: true },
    });
    expect(reply.interruption).toEqual({ heardCharacterCount: 16, spokenCharacterCount: 16, partial: true });

    await expect(repository.markReplyInterrupted({ workspaceId, conversationId, messageId: reply.id, heardCharacterCount: 3, spokenCharacterCount: 16 }))
      .resolves.toBe(true);

    const reloaded = await repository.findByIdAndWorkspaceId(workspaceId, reply.id);
    expect(reloaded?.interruption).toEqual({ heardCharacterCount: 16, spokenCharacterCount: 16, partial: true });
    // Born marked, so the tail never returns it again for its marker.
    expect(reloaded?.metadata?.interruption).toEqual({ heardCharacterCount: 16, spokenCharacterCount: 16, partial: true });
  });

  it("marks a reply whose metadata holds a null interruption, which reads as unmarked", async () => {
    const reply = await repository.create({ conversationId, workspaceId, role: "assistant", content: "We open at nine.", metadata: { interruption: null } });
    expect((await repository.findByIdAndWorkspaceId(workspaceId, reply.id))?.interruption).toBeUndefined();

    await expect(repository.markReplyInterrupted({ workspaceId, conversationId, messageId: reply.id, heardCharacterCount: 7, spokenCharacterCount: 16 }))
      .resolves.toBe(true);

    expect((await repository.findByIdAndWorkspaceId(workspaceId, reply.id))?.interruption).toEqual({ heardCharacterCount: 7, spokenCharacterCount: 16, partial: false });
  });

  it("leaves a message alone that is not an assistant reply of the conversation", async () => {
    const otherConversationId = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)`, [otherConversationId, workspaceId]);
    const question = await repository.create({ conversationId, workspaceId, role: "user", content: "When do you open?" });
    const otherReply = await repository.create({ conversationId: otherConversationId, workspaceId, role: "assistant", content: "At nine." });
    const counts = { heardCharacterCount: 3, spokenCharacterCount: 8 };

    await expect(repository.markReplyInterrupted({ workspaceId, conversationId, messageId: question.id, ...counts })).resolves.toBe(false);
    await expect(repository.markReplyInterrupted({ workspaceId, conversationId, messageId: otherReply.id, ...counts })).resolves.toBe(false);
    await expect(repository.markReplyInterrupted({ workspaceId: randomUUID(), conversationId: otherConversationId, messageId: otherReply.id, ...counts })).resolves.toBe(false);
    await expect(repository.markReplyInterrupted({ workspaceId, conversationId, messageId: randomUUID(), ...counts })).resolves.toBe(false);

    expect((await repository.findByIdAndWorkspaceId(workspaceId, question.id))?.metadata).not.toHaveProperty("interruption");
    expect((await repository.findByIdAndWorkspaceId(workspaceId, otherReply.id))?.metadata).not.toHaveProperty("interruption");
    expect((await repository.findByIdAndWorkspaceId(workspaceId, otherReply.id))?.interruption).toBeUndefined();
  });

  describe("tail re-delivery of marked replies", () => {
    const sinceCursor = (cursor: string | null) => {
      const { keys } = decodeCursorWithKeys(cursor!, ["createdAt", "id"]);
      return { sinceCreatedAt: keys.createdAt, sinceId: keys.id, sinceMarkedAt: (keys as Record<string, string>).markedAt };
    };
    const tail = (cursor: string | null, redeliverMarkedReplies = true) =>
      repository.listSinceByConversationId(workspaceId, conversationId, { ...sinceCursor(cursor), limit: 10, redeliverMarkedReplies });
    const markReply = (messageId: string) =>
      repository.markReplyInterrupted({ workspaceId, conversationId, messageId, heardCharacterCount: 7, spokenCharacterCount: 16 });
    // Whole milliseconds, as the cursor keeps them, so a read after the cursor's own message starts
    // strictly after it. The marker is recorded on the database clock, after the reply and before the
    // later message.
    const createAt = async (role: "user" | "assistant", content: string, iso: string) => {
      const message = await repository.create({ conversationId, workspaceId, role, content });
      await setTime(message.id, iso);
      return message;
    };

    it("re-delivers a reply marked after the cursor once, and only to a tail that asks for it", async () => {
      await createAt("user", "When do you open?", "2026-06-01T00:00:00.000Z");
      const reply = await createAt("assistant", "We open at nine.", "2026-06-01T00:00:01.000Z");
      const { latestCursor: seen } = await repository.listSinceByConversationId(workspaceId, conversationId, { limit: 10 });
      expect((await tail(seen)).messages).toEqual([]);

      await markReply(reply.id);

      expect((await tail(seen, false)).messages).toEqual([]);
      const redelivered = await tail(seen);
      expect(redelivered.messages.map((message) => [message.id, message.interruption])).toEqual([
        [reply.id, { heardCharacterCount: 7, spokenCharacterCount: 16, partial: false }],
      ]);
      expect(decodeCursorWithKeys(redelivered.latestCursor!, ["createdAt", "id"]).keys.id).toBe(reply.id);
      expect((await tail(redelivered.latestCursor)).messages).toEqual([]);
    });

    it("orders a re-delivered reply with the new messages, and moves the cursor past both", async () => {
      const reply = await createAt("assistant", "We open at nine.", "2026-06-01T00:00:01.000Z");
      const { latestCursor: seen } = await repository.listSinceByConversationId(workspaceId, conversationId, { limit: 10 });

      await markReply(reply.id);
      const next = await createAt("user", "And Sunday?", "2099-01-01T00:00:00.000Z");

      const page = await tail(seen);
      expect(page.messages.map((message) => message.id)).toEqual([reply.id, next.id]);
      expect(decodeCursorWithKeys(page.latestCursor!, ["createdAt", "id"]).keys.id).toBe(next.id);
      expect((await tail(page.latestCursor)).messages).toEqual([]);
    });

    it("re-delivers a teammate's reply once the caller heard it, after an interruption it already delivered", async () => {
      const agentReply = await createAt("assistant", "We open at nine.", "2026-06-01T00:00:01.000Z");
      const teammateReply = await repository.create({
        conversationId, workspaceId, role: "assistant", source: "human_agent", content: "Four works.", pendingSpeech: true,
      });
      await setTime(teammateReply.id, "2026-06-01T00:00:02.000Z");
      const { latestCursor: seen } = await repository.listSinceByConversationId(workspaceId, conversationId, { limit: 10 });

      await markReply(agentReply.id);
      const interrupted = await tail(seen);
      expect(interrupted.messages.map((message) => message.id)).toEqual([agentReply.id]);

      await repository.claimPendingOperatorReplies({ workspaceId, conversationId, claimTurnId: "turn-1" });
      await repository.markOperatorRepliesSpoken({ workspaceId, conversationId, messageIds: [teammateReply.id], claimTurnId: "turn-1" });

      const spoken = await tail(interrupted.latestCursor);
      expect(spoken.messages.map((message) => [message.id, message.speech?.state])).toEqual([[teammateReply.id, "spoken"]]);
      expect((await tail(spoken.latestCursor)).messages).toEqual([]);
    });

    it("re-delivers a teammate's reply once it is skipped for having no words to say", async () => {
      const wordless = await repository.create({
        conversationId, workspaceId, role: "assistant", source: "human_agent", content: "**", pendingSpeech: true,
      });
      await setTime(wordless.id, "2026-06-01T00:00:01.000Z");
      const { latestCursor: seen } = await repository.listSinceByConversationId(workspaceId, conversationId, { limit: 10 });

      await repository.claimPendingOperatorReplies({ workspaceId, conversationId, claimTurnId: "turn-1" });
      await repository.skipOperatorReplies({ workspaceId, conversationId, messageIds: [wordless.id], claimTurnId: "turn-1" });

      const skipped = await tail(seen);
      expect(skipped.messages.map((message) => [message.id, message.speech?.state])).toEqual([[wordless.id, "skipped"]]);
      expect((await tail(skipped.latestCursor)).messages).toEqual([]);
    });
  });

  describe("a teammate's replies on a call", () => {
    const teammateReply = (content: string, iso: string, pendingSpeech = true) =>
      repository.create({ conversationId, workspaceId, role: "assistant", source: "human_agent", content, operatorUserId: "user-1", pendingSpeech })
        .then(async (message) => {
          await setTime(message.id, iso);
          return message;
        });
    const claim = (claimTurnId: string, workspace = workspaceId) =>
      repository.claimPendingOperatorReplies({ workspaceId: workspace, conversationId, claimTurnId });
    const claimedIds = async (claimTurnId: string) => (await claim(claimTurnId)).map((reply) => reply.messageId);
    const held = (claimTurnId: string, messageIds: string[], workspace = workspaceId) =>
      ({ workspaceId: workspace, conversationId, messageIds, claimTurnId });
    const speechOf = async (messageId: string) => (await repository.findByIdAndWorkspaceId(workspaceId, messageId))?.speech;
    const storedSpeech = async (messageId: string) =>
      (await repository.findByIdAndWorkspaceId(workspaceId, messageId))?.metadata?.speech as Record<string, unknown> | undefined;
    /** Moves a claim back in time, as a turn whose process stopped leaves it. */
    const ageClaim = (messageId: string, ms: number) =>
      database.query(
        `UPDATE messages SET metadata_json = jsonb_set(metadata_json, '{speech,claimedAt}',
          to_jsonb(to_char((clock_timestamp() - make_interval(secs => $2)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id = $1`,
        [messageId, ms / 1000],
      );

    it("stores a reply the caller hears as pending, and claims and reads the pending ones oldest first in one write", async () => {
      const later = await teammateReply("Bring your card.", "2026-06-01T00:00:03.000Z");
      const first = await teammateReply("We can fit you in at **four**.", "2026-06-01T00:00:01.000Z");
      const wordless = await teammateReply("**", "2026-06-01T00:00:02.000Z");
      await teammateReply("Written, never spoken.", "2026-06-01T00:00:04.000Z", false);
      await repository.create({ conversationId, workspaceId, role: "assistant", content: "We open at nine.", metadata: { speech: { state: "pending" } } });

      expect(await speechOf(first.id)).toEqual({ state: "pending" });
      expect((await repository.findByIdAndWorkspaceId(workspaceId, first.id))?.metadata).toMatchObject({ humanAgent: { userId: "user-1" } });
      await expect(claim("turn-a", randomUUID())).resolves.toEqual([]);
      expect(await claim("turn-a")).toEqual([
        { messageId: first.id, text: "We can fit you in at **four**." },
        { messageId: wordless.id, text: "**" },
        { messageId: later.id, text: "Bring your card." },
      ]);
      expect(await storedSpeech(first.id)).toEqual({ state: "claimed", claimTurnId: "turn-a", claimedAt: expect.any(String) });
      // A claim still reads as pending to everyone else.
      expect(await speechOf(first.id)).toEqual({ state: "pending" });
    });

    it("claims a pending reply for one turn only, and lets another claim it once released", async () => {
      const reply = await teammateReply("Four works.", "2026-06-01T00:00:01.000Z");

      expect(await claimedIds("turn-a")).toEqual([reply.id]);
      expect(await claimedIds("turn-b")).toEqual([]);

      await expect(repository.releaseOperatorReplies(held("turn-b", [reply.id]))).resolves.toEqual([]);
      expect(await claimedIds("turn-b")).toEqual([]);
      await expect(repository.releaseOperatorReplies(held("turn-a", [reply.id]))).resolves.toEqual([reply.id]);
      expect(await claimedIds("turn-b")).toEqual([reply.id]);
    });

    it("lets one of two turns claiming at once have each reply", async () => {
      const reply = await teammateReply("Four works.", "2026-06-01T00:00:01.000Z");

      const claims = await Promise.all([claimedIds("turn-a"), claimedIds("turn-b")]);

      expect(claims.flat()).toEqual([reply.id]);
    });

    it("lets a later turn claim a reply whose claim is older than the expiry", async () => {
      const reply = await teammateReply("Four works.", "2026-06-01T00:00:01.000Z");
      await claim("turn-a");

      await ageClaim(reply.id, VOICE_BEHAVIOR.operatorReplyClaimExpiryMs - 5_000);
      expect(await claimedIds("turn-b")).toEqual([]);

      await ageClaim(reply.id, VOICE_BEHAVIOR.operatorReplyClaimExpiryMs + 5_000);
      expect(await claimedIds("turn-b")).toEqual([reply.id]);
      // The turn whose claim expired no longer holds it: it can neither mark nor release it.
      await expect(repository.markOperatorRepliesSpoken(held("turn-a", [reply.id]))).resolves.toEqual([]);
      await expect(repository.releaseOperatorReplies(held("turn-a", [reply.id]))).resolves.toEqual([]);
    });

    it("marks the replies a turn holds spoken once, keeps the first time, and leaves every other message alone", async () => {
      const reply = await teammateReply("Four works.", "2026-06-01T00:00:01.000Z");
      const agentReply = await repository.create({ conversationId, workspaceId, role: "assistant", content: "We open at nine." });
      const question = await repository.create({ conversationId, workspaceId, role: "user", content: "When?" });
      await claim("turn-a");
      const unclaimed = await teammateReply("Bring your card.", "2026-06-01T00:00:02.000Z");

      await expect(repository.markOperatorRepliesSpoken(held("turn-a", [reply.id], randomUUID()))).resolves.toEqual([]);
      await expect(repository.markOperatorRepliesSpoken(held("turn-a", [reply.id, unclaimed.id, agentReply.id, question.id, randomUUID()])))
        .resolves.toEqual([reply.id]);
      const spoken = await speechOf(reply.id);
      expect(spoken).toEqual({ state: "spoken", spokenAt: expect.any(String) });
      expect(new Date(spoken!.spokenAt!).toISOString()).toBe(spoken!.spokenAt);
      expect(await speechOf(unclaimed.id)).toEqual({ state: "pending" });

      await expect(repository.markOperatorRepliesSpoken(held("turn-a", [reply.id]))).resolves.toEqual([]);
      expect(await claimedIds("turn-b")).toEqual([unclaimed.id]);
      await expect(repository.releaseOperatorReplies(held("turn-a", [reply.id]))).resolves.toEqual([]);
      expect(await speechOf(reply.id)).toEqual(spoken);
      expect((await repository.findByIdAndWorkspaceId(workspaceId, agentReply.id))?.metadata).not.toHaveProperty("speech");
      expect((await repository.findByIdAndWorkspaceId(workspaceId, question.id))?.metadata).not.toHaveProperty("speech");
    });

    it("marks a claimed reply with no words to say as skipped, which no turn claims again", async () => {
      const wordless = await teammateReply("**", "2026-06-01T00:00:01.000Z");
      await claim("turn-a");

      await expect(repository.skipOperatorReplies(held("turn-b", [wordless.id]))).resolves.toEqual([]);
      await expect(repository.skipOperatorReplies(held("turn-a", [wordless.id]))).resolves.toEqual([wordless.id]);

      expect(await speechOf(wordless.id)).toEqual({ state: "skipped" });
      await ageClaim(wordless.id, VOICE_BEHAVIOR.operatorReplyClaimExpiryMs + 5_000);
      expect(await claimedIds("turn-b")).toEqual([]);
    });
  });

  it("windows newest-first with a stable cursor and total", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await repository.create({ conversationId, workspaceId, role: "user", content: `m${i}` });
      await setTime(m.id, `2026-06-01T00:00:0${i}.000Z`);
      ids.push(m.id);
    }
    // newest-first window of 2
    const page1 = await repository.listWindowByConversationId(workspaceId, conversationId, { limit: 2 });
    expect(page1.total).toBe(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.messages.map((m) => m.id)).toEqual([ids[1], ids[2]]); // returned oldest→newest within the page

    const page2 = await repository.listWindowByConversationId(workspaceId, conversationId, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.id)).toEqual([ids[0]]);
    expect(page2.hasMore).toBe(false);
  });

  it("loses no message within the cursor's millisecond when paging a window back, at full Postgres precision", async () => {
    const earliest = await repository.create({ conversationId, workspaceId, role: "user", content: "earliest" });
    const middle = await repository.create({ conversationId, workspaceId, role: "user", content: "middle" });
    const newest = await repository.create({ conversationId, workspaceId, role: "user", content: "newest" });
    // All three read back as the same millisecond in a JS Date; only the microseconds order them.
    await setTime(earliest.id, "2026-06-05T00:00:00.123100Z");
    await setTime(middle.id, "2026-06-05T00:00:00.123200Z");
    await setTime(newest.id, "2026-06-05T00:00:00.123456Z");

    const page1 = await repository.listWindowByConversationId(workspaceId, conversationId, { limit: 1 });
    expect(page1.messages.map((m) => m.id)).toEqual([newest.id]);
    expect(page1.hasMore).toBe(true);

    const page2 = await repository.listWindowByConversationId(workspaceId, conversationId, {
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.id)).toEqual([middle.id]);
    expect(page2.hasMore).toBe(true);

    const page3 = await repository.listWindowByConversationId(workspaceId, conversationId, {
      limit: 1,
      cursor: page2.nextCursor!,
    });
    expect(page3.messages.map((m) => m.id)).toEqual([earliest.id]);
    expect(page3.hasMore).toBe(false);
  });

  it("windows nothing for a cursor whose boundary is not a message of the conversation", async () => {
    const otherConversationId = randomUUID();
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)`, [otherConversationId, workspaceId]);
    await repository.create({ conversationId, workspaceId, role: "user", content: "kept" });
    const erased = await repository.create({ conversationId, workspaceId, role: "user", content: "will be erased" });
    const foreign = await repository.create({ conversationId: otherConversationId, workspaceId, role: "user", content: "other conversation" });
    const cursorFor = (message: { id: string; createdAt: Date }) =>
      encodeCursor({ createdAt: message.createdAt.toISOString(), id: message.id });
    const erasedCursor = cursorFor(erased);

    expect(await repository.deleteUserMessage({ workspaceId, conversationId, messageId: erased.id })).toBe(true);

    // A deleted message's own cursor has nothing after it.
    const deletedWindow = await repository.listWindowByConversationId(workspaceId, conversationId, {
      limit: 10,
      cursor: erasedCursor,
    });
    expect(deletedWindow.messages).toEqual([]);
    expect(deletedWindow.hasMore).toBe(false);
    expect(deletedWindow.nextCursor).toBeNull();

    // Another conversation's message id is just as unresolvable as a deleted one.
    const foreignWindow = await repository.listWindowByConversationId(workspaceId, conversationId, {
      limit: 10,
      cursor: cursorFor(foreign),
    });
    expect(foreignWindow.messages).toEqual([]);
    expect(foreignWindow.hasMore).toBe(false);
    expect(foreignWindow.nextCursor).toBeNull();
  });

  it("lists the newest messages before a (created_at, id) boundary, oldest first, ignoring later ones before limiting", async () => {
    const created = [];
    for (let i = 0; i < 7; i += 1) {
      created.push(await repository.create({ conversationId, workspaceId, role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
    }
    for (const [index, message] of created.entries()) {
      await setTime(message.id, `2026-06-01T00:00:0${index}.000Z`);
    }
    // A message sharing the boundary's timestamp orders by id: one sorting before it is earlier, one after it later.
    const tied = await repository.create({ conversationId, workspaceId, role: "user", content: "tied" });
    const boundary = created[4];
    await setTime(tied.id, "2026-06-01T00:00:04.000Z");
    const tiedIsEarlier = tied.id < boundary.id;

    const window = await repository.listBeforeByConversationId(workspaceId, conversationId, {
      beforeMessageId: boundary.id,
      limit: 3,
    });

    const expected = tiedIsEarlier
      ? [created[2].id, created[3].id, tied.id]
      : [created[1].id, created[2].id, created[3].id];
    expect(window.map((message) => message.id)).toEqual(expected);
    expect(await repository.listBeforeByConversationId(workspaceId, conversationId, {
      beforeMessageId: boundary.id,
      limit: 0,
    })).toEqual([]);
    expect(await repository.listBeforeByConversationId(randomUUID(), conversationId, {
      beforeMessageId: boundary.id,
      limit: 3,
    })).toEqual([]);
    // A boundary that is not a message of the conversation has nothing before it.
    expect(await repository.listBeforeByConversationId(workspaceId, conversationId, {
      beforeMessageId: randomUUID(),
      limit: 3,
    })).toEqual([]);
  });

  it("keeps a predecessor recorded within the same millisecond as the boundary, at full Postgres precision", async () => {
    const earlier = await repository.create({ conversationId, workspaceId, role: "user", content: "earlier" });
    const boundary = await repository.create({ conversationId, workspaceId, role: "user", content: "boundary" });
    // Both read back as .123 in a JavaScript Date; only the microseconds order them.
    await setTime(earlier.id, "2026-06-02T00:00:00.123100Z");
    await setTime(boundary.id, "2026-06-02T00:00:00.123900Z");
    // A later message within the same millisecond, sorting before the boundary by id or not, stays out.
    const later = await repository.create({ conversationId, workspaceId, role: "user", content: "later" });
    await setTime(later.id, "2026-06-02T00:00:00.123950Z");

    const window = await repository.listBeforeByConversationId(workspaceId, conversationId, {
      beforeMessageId: boundary.id,
      limit: 1,
    });

    expect(window.map((message) => message.id)).toEqual([earlier.id]);
  });

  it("filters the newest messages by role before limiting, so a filtered-out row takes no place", async () => {
    const roles = ["user", "assistant", "system", "system", "user"] as const;
    const created = [];
    for (const [index, role] of roles.entries()) {
      const message = await repository.create({ conversationId, workspaceId, role, content: `m${index}` });
      await setTime(message.id, `2026-06-01T00:00:0${index}.000Z`);
      created.push(message);
    }

    const window = await repository.listRecentByConversationId(workspaceId, conversationId, 2, { roles: ["user", "assistant"] });

    expect(window.map((message) => message.id)).toEqual([created[1].id, created[4].id]);
    expect(await repository.listRecentByConversationId(workspaceId, conversationId, 2, { roles: [] })).toEqual([]);
    expect((await repository.listRecentByConversationId(workspaceId, conversationId, 2)).map((message) => message.id))
      .toEqual([created[3].id, created[4].id]);
  });

  it("summarizes counts and previews by conversation", async () => {
    await repository.create({ conversationId, workspaceId, role: "user", content: "question" });
    await repository.create({ conversationId, workspaceId, role: "assistant", content: "the answer" });
    const summaries = await repository.summarizeByConversationIds(workspaceId, [conversationId]);
    const summary = summaries.get(conversationId);
    expect(summary?.messageCount).toBe(2);
    expect(summary?.userMessageCount).toBe(1);
    expect(summary?.assistantMessageCount).toBe(1);
    expect(summary?.preview).toBeTruthy();
  });

  it("previews the visitor's first user message, not the newest agent reply", async () => {
    const greeting = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "Hi, how can I help?",
    });
    await setTime(greeting.id, "2026-06-02T00:00:00.000Z");

    const question = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: "What are your shop hours?",
    });
    await setTime(question.id, "2026-06-02T00:00:01.000Z");

    const reply = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "We're open 9-5",
    });
    await setTime(reply.id, "2026-06-02T00:00:02.000Z");

    const summaries = await repository.summarizeByConversationIds(workspaceId, [conversationId]);
    const summary = summaries.get(conversationId);
    expect(summary?.preview).toBe("What are your shop hours?");
  });

  it("falls back to the newest message preview when a conversation has no user message yet", async () => {
    const greeting = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "Hi, how can I help?",
    });
    await setTime(greeting.id, "2026-06-03T00:00:00.000Z");

    const followUp = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "Still here if you need anything",
    });
    await setTime(followUp.id, "2026-06-03T00:00:01.000Z");

    const summaries = await repository.summarizeByConversationIds(workspaceId, [conversationId]);
    const summary = summaries.get(conversationId);
    expect(summary?.preview).toBe("Still here if you need anything");
  });

  it("skips a whitespace-only first user message and previews the next meaningful one", async () => {
    const blank = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: "   ",
    });
    await setTime(blank.id, "2026-06-04T00:00:00.000Z");

    const greeting = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "Hi, how can I help?",
    });
    await setTime(greeting.id, "2026-06-04T00:00:01.000Z");

    const question = await repository.create({
      conversationId,
      workspaceId,
      role: "user",
      content: "What are your shop hours?",
    });
    await setTime(question.id, "2026-06-04T00:00:02.000Z");

    const reply = await repository.create({
      conversationId,
      workspaceId,
      role: "assistant",
      content: "We're open 9-5",
    });
    await setTime(reply.id, "2026-06-04T00:00:03.000Z");

    const summaries = await repository.summarizeByConversationIds(workspaceId, [conversationId]);
    const summary = summaries.get(conversationId);
    expect(summary?.preview).toBe("What are your shop hours?");
  });
});
