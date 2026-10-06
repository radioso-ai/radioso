import { describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "../../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../src/db/repositories/messageRepository.js";
import type { ConversationActivityEvent } from "../../../src/modules/conversationActivity/contracts/index.js";
import { heldReplyTransition, type HeldReplyEvent } from "../../../src/modules/handoff/heldReplies/heldReplyState.js";
import {
  CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
  ConversationOwnershipService,
  type ConversationOperator,
  type HeldReplyState,
  type OperatorReplyService,
  type OwnershipActor,
} from "../../../src/modules/handoff/public.js";
import { InMemoryActionOutbox, InMemoryConversationOwnershipRepository } from "../../support/fakes.js";

const workspaceId = "workspace-1";
const accountId = "account-1";
const conversationId = "conversation-1";

const dana: OwnershipActor = { accountId, workspaceId, userId: "user-dana" };
const fox: OwnershipActor = { accountId, workspaceId, userId: "user-fox" };

const operators: Record<string, ConversationOperator> = {
  "user-dana": { userId: "user-dana", label: "Dana Scully" },
  "user-fox": { userId: "user-fox", label: "Fox Mulder" },
};

const conversationRecord = { id: conversationId, workspaceId } as ConversationRecord;

type OperatorReply = Parameters<OperatorReplyService["prepare"]>[0];

interface HeldReplyRow {
  state: HeldReplyState;
  supersededReason: string | null;
  attentionCleared: string | null;
}

/**
 * The conversation's held replies behind the supersede scope, moved by the real held-reply machine.
 * Each call is recorded as a step, so a test can tell which unit of work it ran in.
 */
const createHeldReplies = (steps: string[]) => {
  const rows = new Map<string, HeldReplyRow>();
  const apply = (event: HeldReplyEvent): number => {
    let changed = 0;
    for (const [id, row] of rows) {
      const transition = heldReplyTransition(row.state, event);
      if (!transition || (event.kind === "clear_discarded_attention" && row.attentionCleared !== null)) {
        continue;
      }
      rows.set(id, {
        state: transition.state,
        supersededReason: event.kind === "supersede" ? event.reason : row.supersededReason,
        attentionCleared: transition.attentionCleared,
      });
      changed += 1;
    }
    return changed;
  };
  return {
    rows,
    seed: (id: string, state: HeldReplyState) => rows.set(id, { state, supersededReason: null, attentionCleared: null }),
    supersedePendingForConversation: vi.fn(async (_conversationId: string, reason: "newer_inbound" | "takeover" | "operator_reply") => {
      steps.push(`held_replies:supersede:${reason}`);
      return apply({ kind: "supersede", reason });
    }),
    clearDiscardedAttention: vi.fn(async (_conversationId: string, reason: "operator_reply" | "takeover") => {
      steps.push(`held_replies:clear_discarded:${reason}`);
      return apply({ kind: "clear_discarded_attention", reason });
    }),
  };
};

const createService = (options: {
  outbox?: { enqueue: InMemoryActionOutbox["enqueue"] };
  audit?: { record: (event: unknown) => Promise<void> };
  activity?: { record: (event: ConversationActivityEvent) => Promise<void> };
} = {}) => {
  const ownership = new InMemoryConversationOwnershipRepository();
  const outbox = new InMemoryActionOutbox();
  const audit = { record: vi.fn(options.audit?.record ?? (async () => undefined)) };
  const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
  const logger = { warn: vi.fn() };
  const errorReporter = { report: vi.fn(async () => undefined) };
  const conversations = {
    findByIdAndWorkspaceId: vi.fn(async (id: string, inWorkspace: string) =>
      id === conversationId && inWorkspace === workspaceId ? conversationRecord : null),
  };
  const operatorIdentities = {
    resolve: vi.fn(async (input: { userId: string }) => ({
      userId: input.userId,
      teammateLabel: operators[input.userId]?.label ?? input.userId,
      replySignature: null,
    })),
  };
  // Every step a reply takes, in order, so a test can assert what happens before what.
  const steps: string[] = [];
  // The activity each unit of work records, in the order it was recorded.
  const activityEvents: ConversationActivityEvent[] = [];
  const activity = {
    record: vi.fn(async (event: ConversationActivityEvent) => {
      steps.push(`activity:${event.kind}`);
      await options.activity?.record(event);
      activityEvents.push(event);
    }),
  };
  const replyScope = { messages: { create: vi.fn() }, conversations: { touch: vi.fn() }, outbox: { enqueue: vi.fn() } };
  const heldReplies = createHeldReplies(steps);
  // Marks where each unit of work opens and commits, so a step between the two ran inside it.
  const inUnitOfWork = async <T>(work: () => Promise<T>): Promise<T> => {
    steps.push("begin");
    const result = await work();
    steps.push("commit");
    return result;
  };
  const lockedConversations = {
    lockForUpdate: vi.fn(async (id: string, inWorkspace: string) => {
      steps.push("lock_conversation");
      return id === conversationId && inWorkspace === workspaceId;
    }),
  };
  const replies = {
    prepare: vi.fn(async (reply: OperatorReply) => {
      steps.push("prepare");
      return { ...reply, channel: null };
    }),
    write: vi.fn(async (_scope: unknown, reply: { conversation: ConversationRecord; message: string }): Promise<MessageRecord> => {
      steps.push("write");
      return {
        id: "message-1",
        conversationId: reply.conversation.id,
        workspaceId: reply.conversation.workspaceId,
        role: "assistant",
        source: "human_agent",
        content: reply.message,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      };
    }),
    announce: vi.fn(() => {
      steps.push("announce");
    }),
    audit: vi.fn(async () => {
      steps.push("audit:replied");
    }),
  };
  const originalLoadForUpdate = ownership.loadForUpdate.bind(ownership);
  const loadForUpdate = vi.spyOn(ownership, "loadForUpdate").mockImplementation(async (id: string) => {
    steps.push("lock_ownership");
    return originalLoadForUpdate(id);
  });
  audit.record.mockImplementation(async (event: unknown) => {
    steps.push(`audit:${(event as { metadata: { action: string } }).metadata.action}`);
    await (options.audit?.record ?? (async () => undefined))(event);
  });
  const service = new ConversationOwnershipService({
    conversations,
    ownership,
    changes: {
      run: (work) => inUnitOfWork(() => work({ ownership, outbox: options.outbox ?? outbox, activity, heldReplies })),
    },
    replyWrites: {
      run: (work) => inUnitOfWork(() => work({ conversations: lockedConversations, ownership, reply: replyScope, activity, heldReplies })),
    },
    operators: {
      find: vi.fn(async (input: { userId: string }) => operators[input.userId] ?? null),
    },
    operatorIdentities,
    replies,
    audit,
    publisher,
    logger,
    errorReporter,
  });
  return {
    service, ownership, outbox, audit, publisher, replies, replyScope, conversations, lockedConversations, operatorIdentities,
    loadForUpdate, logger, errorReporter, steps, activity, activityEvents, heldReplies,
  };
};

const auditedActions = (audit: { record: ReturnType<typeof vi.fn> }): unknown[] =>
  audit.record.mock.calls.map(([event]) => (event as { metadata: { action: string } }).metadata.action);

describe("ConversationOwnershipService", () => {
  describe("reply", () => {
    it("lets the owner reply at the version they saw", async () => {
      const { service, replies, replyScope } = createService();
      const claim = await service.takeOver(dana, { conversationId });

      const result = await service.reply(dana, { conversationId, message: "Hello", expectedVersion: claim.record!.version });

      expect(result).toMatchObject({ ok: true, record: { ownerUserId: "user-dana", version: 1 } });
      expect(replies.prepare).toHaveBeenCalledWith({
        conversation: conversationRecord,
        accountId,
        operator: { userId: "user-dana", teammateLabel: "Dana Scully", replySignature: null },
        message: "Hello",
      });
      expect(replies.write).toHaveBeenCalledWith(replyScope, await replies.prepare.mock.results[0].value);
      expect(replies.announce).toHaveBeenCalledWith(replies.write.mock.calls[0][1], expect.objectContaining({ id: "message-1" }));
      expect(replies.audit).toHaveBeenCalledWith(replies.write.mock.calls[0][1], expect.objectContaining({ id: "message-1" }));
    });

    it("locks the conversation, then its ownership, then writes; and tells the visitor before auditing", async () => {
      const { service, steps } = createService();

      await service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 });

      expect(steps).toEqual([
        "prepare",
        "begin",
        "lock_conversation",
        "lock_ownership",
        "activity:claimed",
        "held_replies:supersede:operator_reply",
        "held_replies:clear_discarded:operator_reply",
        "write",
        "commit",
        "announce",
        "audit:taken_over",
        "audit:replied",
      ]);
    });

    it("answers not found, writing nothing, when the conversation is gone by the time the reply locks it", async () => {
      const { service, replies, lockedConversations } = createService();
      lockedConversations.lockForUpdate.mockResolvedValueOnce(false);

      await expect(service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 }))
        .rejects.toMatchObject({ statusCode: 404, code: "not_found" });
      expect(replies.write).not.toHaveBeenCalled();
      expect(replies.announce).not.toHaveBeenCalled();
    });

    it("fails the reply, telling no one, when writing it fails", async () => {
      const { service, replies, audit, publisher } = createService();
      replies.write.mockRejectedValueOnce(new Error("outbox unavailable"));

      await expect(service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 })).rejects.toThrow("outbox unavailable");
      expect(replies.announce).not.toHaveBeenCalled();
      expect(replies.audit).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(publisher.enqueue).not.toHaveBeenCalled();
    });

    it("reads the conversation and the replier together", async () => {
      const { service, conversations, operatorIdentities } = createService();
      let releaseConversation: (() => void) | undefined;
      conversations.findByIdAndWorkspaceId.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseConversation = resolve; });
        return conversationRecord;
      });

      const reply = service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 });
      await vi.waitFor(() => expect(operatorIdentities.resolve).toHaveBeenCalledTimes(1));
      releaseConversation?.();

      await expect(reply).resolves.toMatchObject({ ok: true });
    });

    it("refuses a teammate's reply while another teammate owns the conversation", async () => {
      const { service, replies } = createService();
      const claim = await service.takeOver(dana, { conversationId });

      const result = await service.reply(fox, { conversationId, message: "Me too", expectedVersion: claim.record!.version });

      expect(result).toMatchObject({ ok: false, refusal: "held_by_teammate", record: { ownerUserId: "user-dana" } });
      expect(replies.write).not.toHaveBeenCalled();
      expect(replies.announce).not.toHaveBeenCalled();
    });

    it("refuses the owner's reply from a stale view", async () => {
      const { service, replies } = createService();
      await service.takeOver(dana, { conversationId });

      const result = await service.reply(dana, { conversationId, message: "Hello", expectedVersion: 0 });

      expect(result).toMatchObject({ ok: false, refusal: "stale" });
      expect(replies.write).not.toHaveBeenCalled();
    });

    it("decides on the ownership it locked, so a transfer that lands first refuses the reply", async () => {
      const { service, ownership, replies } = createService();
      const claim = await service.takeOver(dana, { conversationId });
      // Fox takes the conversation after Dana pressed Send, before her reply is written.
      replies.prepare.mockImplementationOnce(async (reply: OperatorReply) => {
        await ownership.transfer({
          conversationId, accountId, userId: "user-fox", displayName: "Fox Mulder", expectedVersion: claim.record!.version,
        });
        return { ...reply, channel: null };
      });

      const result = await service.reply(dana, { conversationId, message: "Hello", expectedVersion: claim.record!.version });

      expect(result).toMatchObject({ ok: false, refusal: "held_by_teammate", record: { ownerUserId: "user-fox" } });
      expect(replies.write).not.toHaveBeenCalled();
      expect(replies.announce).not.toHaveBeenCalled();
    });

    it("reads the conversation, the replier and the ownership once each, even when the reply claims it", async () => {
      const { service, ownership, conversations, operatorIdentities, loadForUpdate } = createService();
      const requested = await ownership.requestHandoff({ conversationId, workspaceId, reason: "routine_handoff" });
      const load = vi.spyOn(ownership, "load");

      await service.reply(fox, { conversationId, message: "On it", expectedVersion: requested.record.version });

      expect(conversations.findByIdAndWorkspaceId).toHaveBeenCalledTimes(1);
      expect(operatorIdentities.resolve).toHaveBeenCalledTimes(1);
      expect(loadForUpdate).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalled();
    });

    it("claims a handoff nobody has claimed for the teammate who replies", async () => {
      const { service, ownership, replies, audit } = createService();
      const requested = await ownership.requestHandoff({ conversationId, workspaceId, reason: "routine_handoff" });

      const result = await service.reply(fox, { conversationId, message: "On it", expectedVersion: requested.record.version });

      expect(result).toMatchObject({ ok: true, record: { state: "human_owned", ownerUserId: "user-fox", version: 2 } });
      expect(replies.write).toHaveBeenCalledTimes(1);
      expect(auditedActions(audit)).toEqual(["taken_over"]);
    });

    it("takes an AI-owned conversation over before replying", async () => {
      const { service, replies, publisher } = createService();

      const result = await service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 });

      expect(result).toMatchObject({ ok: true, record: { state: "human_owned", ownerUserId: "user-fox" } });
      expect(replies.write).toHaveBeenCalledTimes(1);
      expect(replies.announce).toHaveBeenCalledTimes(1);
      expect(publisher.enqueue).toHaveBeenCalledWith(workspaceId, ["conversation.ownership_changed"]);
    });

    it("sends a reply that claimed the conversation even when the claim's audit record fails", async () => {
      const { service, replies } = createService({ audit: { record: async () => { throw new Error("audit unavailable"); } } });

      const result = await service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 });

      expect(result).toMatchObject({ ok: true, record: { ownerUserId: "user-fox" } });
      expect(replies.announce).toHaveBeenCalledTimes(1);
    });

    it("answers a committed claim-and-reply when telling the dashboard of the claim throws", async () => {
      const { service, publisher, replies, logger } = createService();
      publisher.enqueue.mockImplementation(() => { throw new Error("publisher down"); });

      const result = await service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 });

      expect(result).toMatchObject({ ok: true, record: { ownerUserId: "user-fox" } });
      expect(replies.audit).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "hitl_ownership_notification_failed", notification: "dashboard_refresh", conversationId }),
        expect.any(String),
      );
    });
  });

  describe("after a committed change", () => {
    it("keeps the change when its audit record fails, and reports the failure by ids only", async () => {
      const failure = new Error("audit unavailable: postgres://secret@db");
      const { service, ownership, logger, errorReporter, publisher } = createService({
        audit: { record: async () => { throw failure; } },
      });

      const taken = await service.takeOver(dana, { conversationId });
      const transferred = await service.transfer(dana, { conversationId, toUserId: "user-fox", expectedVersion: taken.record!.version });
      const handedBack = await service.handBack(fox, { conversationId, expectedVersion: transferred.record!.version });

      expect([taken.ok, transferred.ok, handedBack.ok]).toEqual([true, true, true]);
      await expect(ownership.load(conversationId)).resolves.toMatchObject({ state: "ai_owned" });
      expect(publisher.enqueue).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledWith({
        event: "hitl_ownership_audit_failed",
        action: "taken_over",
        accountId,
        workspaceId,
        conversationId,
        actorUserId: "user-dana",
        errorClass: "Error",
      }, expect.any(String));
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
      expect(errorReporter.report).toHaveBeenCalledWith(expect.objectContaining({
        errorType: "hitl.ownership.audit_failed",
        error: failure,
        correlation: { accountId, workspaceId, conversationId },
      }));
    });
  });

  describe("activity", () => {
    it("records a claim in the unit of work that claims the conversation, and nothing for a no-op", async () => {
      const { service, activityEvents } = createService();

      await service.takeOver(dana, { conversationId });
      await service.takeOver(dana, { conversationId });

      expect(activityEvents).toEqual([{ kind: "claimed", conversationId, workspaceId, actorUserId: "user-dana" }]);
    });

    it("records a transfer as a reassignment from the teammate who held it to the one who holds it now", async () => {
      const { service, activityEvents } = createService();
      const claim = await service.takeOver(dana, { conversationId });

      await service.transfer(dana, { conversationId, toUserId: "user-fox", expectedVersion: claim.record!.version });

      expect(activityEvents.at(-1)).toEqual({
        kind: "reassigned",
        conversationId,
        workspaceId,
        actorUserId: "user-dana",
        subjectUserId: "user-fox",
        detail: { fromUserId: "user-dana" },
      });
    });

    it("records assigning a handoff nobody has claimed as a reassignment from nobody", async () => {
      const { service, ownership, activityEvents } = createService();
      const requested = await ownership.requestHandoff({ conversationId, workspaceId, reason: "routine_handoff" });

      await service.transfer(dana, { conversationId, toUserId: "user-fox", expectedVersion: requested.record.version });

      expect(activityEvents).toEqual([{
        kind: "reassigned",
        conversationId,
        workspaceId,
        actorUserId: "user-dana",
        subjectUserId: "user-fox",
        detail: { fromUserId: null },
      }]);
    });

    it("records nothing for a transfer that changed nothing or was refused", async () => {
      const { service, activityEvents } = createService();
      const claim = await service.takeOver(dana, { conversationId });

      await service.transfer(dana, { conversationId, toUserId: "user-dana", expectedVersion: claim.record!.version });
      await service.transfer(dana, { conversationId, toUserId: "user-fox", expectedVersion: 99 });

      expect(activityEvents.map((event) => event.kind)).toEqual(["claimed"]);
    });

    it("records a hand-back by the teammate who handed it back", async () => {
      const { service, activityEvents } = createService();
      const claim = await service.takeOver(dana, { conversationId });

      await service.handBack(dana, { conversationId, expectedVersion: claim.record!.version });

      expect(activityEvents.at(-1)).toEqual({ kind: "handed_back", conversationId, workspaceId, actorUserId: "user-dana" });
    });

    it("records the claim a reply makes, and nothing when the owner replies", async () => {
      const { service, activityEvents } = createService();

      const first = await service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 });
      await service.reply(fox, { conversationId, message: "Again", expectedVersion: first.ok ? first.record.version : 0 });

      expect(activityEvents).toEqual([{ kind: "claimed", conversationId, workspaceId, actorUserId: "user-fox" }]);
    });

    it("fails a claim, telling no one, when its activity cannot be recorded", async () => {
      const failure = new Error("activity unavailable");
      const { service, audit, publisher } = createService({ activity: { record: async () => { throw failure; } } });

      await expect(service.takeOver(dana, { conversationId })).rejects.toThrow(failure);

      expect(audit.record).not.toHaveBeenCalled();
      expect(publisher.enqueue).not.toHaveBeenCalled();
    });

    it("fails a reply that would claim the conversation, writing nothing, when the claim cannot be recorded", async () => {
      const failure = new Error("activity unavailable");
      const { service, audit, publisher, replies } = createService({ activity: { record: async () => { throw failure; } } });

      await expect(service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 })).rejects.toThrow(failure);

      expect(replies.write).not.toHaveBeenCalled();
      expect(replies.announce).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(publisher.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("replyRefusal", () => {
    it("names the teammate holding the conversation, and nobody otherwise", async () => {
      const { service } = createService();
      await service.takeOver(dana, { conversationId });

      await expect(service.replyRefusal(fox, conversationId)).resolves.toMatchObject({
        refusal: "held_by_teammate",
        record: { ownerUserId: "user-dana" },
      });
      await expect(service.replyRefusal(dana, conversationId)).resolves.toBeNull();
    });
  });

  describe("handBack", () => {
    it("refuses a hand-back from anyone but the owner", async () => {
      const { service, ownership } = createService();
      const claim = await service.takeOver(dana, { conversationId });

      const result = await service.handBack(fox, { conversationId, expectedVersion: claim.record!.version });

      expect(result).toMatchObject({ ok: false, refusal: "held_by_teammate" });
      await expect(ownership.load(conversationId)).resolves.toMatchObject({ state: "human_owned", ownerUserId: "user-dana" });
    });

    it("lets the owner hand back, and anyone hand back a handoff nobody has claimed", async () => {
      const { service, ownership, audit } = createService();
      const claim = await service.takeOver(dana, { conversationId });
      const handedBack = await service.handBack(dana, { conversationId, expectedVersion: claim.record!.version });
      const requested = await ownership.requestHandoff({ conversationId, workspaceId, reason: "retrieval_miss" });
      const unclaimed = await service.handBack(fox, { conversationId, expectedVersion: requested.record.version });

      expect(handedBack).toMatchObject({ ok: true, changed: true, record: { state: "ai_owned" } });
      expect(unclaimed).toMatchObject({ ok: true, changed: true, record: { state: "ai_owned" } });
      expect(auditedActions(audit)).toEqual(["taken_over", "handed_back", "handed_back"]);
    });
  });

  describe("takeOver", () => {
    it("refuses a conversation a teammate holds: taking it from them is an explicit transfer", async () => {
      const { service, ownership, outbox } = createService();
      await service.takeOver(dana, { conversationId });

      const refused = await service.takeOver(fox, { conversationId });

      expect(refused).toMatchObject({ ok: false, refusal: "held_by_teammate", record: { ownerUserId: "user-dana" } });
      await expect(ownership.load(conversationId)).resolves.toMatchObject({ ownerUserId: "user-dana", version: 1 });
      expect(outbox.items).toEqual([]);
    });

    it("treats taking over a conversation you already hold as a no-op", async () => {
      const { service, audit } = createService();
      await service.takeOver(dana, { conversationId });

      const again = await service.takeOver(dana, { conversationId });

      expect(again).toMatchObject({ ok: true, changed: false, record: { ownerUserId: "user-dana", version: 1 } });
      expect(auditedActions(audit)).toEqual(["taken_over"]);
    });

    it("returns not found for a conversation outside the actor's workspace", async () => {
      const { service } = createService();

      await expect(service.takeOver({ ...dana, workspaceId: "workspace-2" }, { conversationId }))
        .rejects.toMatchObject({ statusCode: 404, code: "not_found" });
    });
  });

  describe("transfer", () => {
    it("hands the conversation over and queues the recipient's notice with the version it produced", async () => {
      const { service, outbox, audit } = createService();
      const claim = await service.takeOver(dana, { conversationId });

      const result = await service.transfer(dana, { conversationId, toUserId: "user-fox", expectedVersion: claim.record!.version });

      expect(result).toMatchObject({ ok: true, changed: true, record: { ownerUserId: "user-fox", version: 2 } });
      expect(outbox.items).toEqual([{
        type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
        payload: { recipientUserId: "user-fox", transferredByUserId: "user-dana", ownershipVersion: 2 },
        accountId,
        workspaceId,
        conversationId,
        idempotencyKey: `conversation-transfer:${conversationId}:2`,
      }]);
      expect(auditedActions(audit)).toEqual(["taken_over", "transferred"]);
    });

    it("fails the transfer, unaudited, when its notice cannot be queued", async () => {
      const failingOutbox = { enqueue: vi.fn(async () => { throw new Error("outbox unavailable"); }) };
      const { service, audit, publisher } = createService({ outbox: failingOutbox });
      const claim = await service.takeOver(dana, { conversationId });
      audit.record.mockClear();
      publisher.enqueue.mockClear();

      await expect(service.transfer(dana, { conversationId, toUserId: "user-fox", expectedVersion: claim.record!.version }))
        .rejects.toThrow("outbox unavailable");

      expect(audit.record).not.toHaveBeenCalled();
      expect(publisher.enqueue).not.toHaveBeenCalled();
    });

    it("tells an unavailable transfer target apart from a missing conversation", async () => {
      const { service } = createService();
      const claim = await service.takeOver(dana, { conversationId });

      await expect(service.transfer(dana, { conversationId, toUserId: "user-stranger", expectedVersion: claim.record!.version }))
        .rejects.toMatchObject({ statusCode: 404, code: "transfer_target_unavailable" });
      await expect(service.transfer(dana, { conversationId: "conversation-missing", toUserId: "user-fox", expectedVersion: 1 }))
        .rejects.toMatchObject({ statusCode: 404, code: "not_found" });
    });
  });

  describe("held replies", () => {
    it.each(["pending", "queued_auto"] as const)(
      "a takeover supersedes a %s draft and closes a discarded draft's attention, in the unit of work that claims",
      async (live) => {
        const { service, heldReplies, steps } = createService();
        heldReplies.seed("held-live", live);
        heldReplies.seed("held-discarded", "discarded");

        await service.takeOver(dana, { conversationId });

        expect(heldReplies.supersedePendingForConversation).toHaveBeenCalledWith(conversationId, "takeover");
        expect(heldReplies.clearDiscardedAttention).toHaveBeenCalledWith(conversationId, "takeover");
        expect(Object.fromEntries(heldReplies.rows)).toEqual({
          "held-live": { state: "superseded", supersededReason: "takeover", attentionCleared: "takeover" },
          "held-discarded": { state: "discarded", supersededReason: null, attentionCleared: "takeover" },
        });
        expect(steps).toEqual([
          "begin",
          "activity:claimed",
          "held_replies:supersede:takeover",
          "held_replies:clear_discarded:takeover",
          "commit",
          "audit:taken_over",
        ]);
      },
    );

    it("leaves held replies alone for a takeover that changes nothing or is refused", async () => {
      const { service, heldReplies } = createService();
      await service.takeOver(dana, { conversationId });
      heldReplies.supersedePendingForConversation.mockClear();
      heldReplies.clearDiscardedAttention.mockClear();

      await service.takeOver(dana, { conversationId });
      await service.takeOver(fox, { conversationId });

      expect(heldReplies.supersedePendingForConversation).not.toHaveBeenCalled();
      expect(heldReplies.clearDiscardedAttention).not.toHaveBeenCalled();
    });

    it("a transfer to yourself supersedes as a takeover, inside the transfer's unit of work", async () => {
      const { service, heldReplies, steps } = createService();
      const claim = await service.takeOver(dana, { conversationId });
      heldReplies.seed("held-live", "pending");
      steps.length = 0;

      await service.transfer(fox, { conversationId, toUserId: "user-fox", expectedVersion: claim.record!.version });

      expect(heldReplies.rows.get("held-live")).toEqual({ state: "superseded", supersededReason: "takeover", attentionCleared: "takeover" });
      expect(steps.slice(0, steps.indexOf("commit") + 1)).toEqual([
        "begin",
        "lock_ownership",
        "activity:reassigned",
        "held_replies:supersede:takeover",
        "held_replies:clear_discarded:takeover",
        "commit",
      ]);
    });

    it("leaves held replies alone for a transfer to a teammate, or one that changed nothing", async () => {
      const { service, heldReplies } = createService();
      const claim = await service.takeOver(dana, { conversationId });
      heldReplies.seed("held-live", "pending");
      heldReplies.supersedePendingForConversation.mockClear();
      heldReplies.clearDiscardedAttention.mockClear();

      await service.transfer(dana, { conversationId, toUserId: "user-dana", expectedVersion: claim.record!.version });
      await service.transfer(dana, { conversationId, toUserId: "user-fox", expectedVersion: claim.record!.version });

      expect(heldReplies.supersedePendingForConversation).not.toHaveBeenCalled();
      expect(heldReplies.clearDiscardedAttention).not.toHaveBeenCalled();
      expect(heldReplies.rows.get("held-live")?.state).toBe("pending");
    });

    it.each(["pending", "queued_auto"] as const)(
      "an operator reply supersedes a %s draft and closes a discarded draft's attention before its message is written",
      async (live) => {
        const { service, heldReplies, steps } = createService();
        const claim = await service.takeOver(dana, { conversationId });
        heldReplies.seed("held-live", live);
        heldReplies.seed("held-discarded", "discarded");
        steps.length = 0;

        await service.reply(dana, { conversationId, message: "Hi", expectedVersion: claim.record!.version });

        expect(Object.fromEntries(heldReplies.rows)).toEqual({
          "held-live": { state: "superseded", supersededReason: "operator_reply", attentionCleared: "operator_reply" },
          "held-discarded": { state: "discarded", supersededReason: null, attentionCleared: "operator_reply" },
        });
        expect(steps.slice(steps.indexOf("begin"), steps.indexOf("commit") + 1)).toEqual([
          "begin",
          "lock_conversation",
          "lock_ownership",
          "held_replies:supersede:operator_reply",
          "held_replies:clear_discarded:operator_reply",
          "write",
          "commit",
        ]);
      },
    );

    it("supersedes nothing for a reply that is refused", async () => {
      const { service, heldReplies } = createService();
      const claim = await service.takeOver(dana, { conversationId });
      heldReplies.supersedePendingForConversation.mockClear();

      await service.reply(fox, { conversationId, message: "Hi" });
      await service.reply(dana, { conversationId, message: "Hi", expectedVersion: claim.record!.version + 1 });

      expect(heldReplies.supersedePendingForConversation).not.toHaveBeenCalled();
    });

    it.each([
      ["takeover", (service: ConversationOwnershipService) => service.takeOver(dana, { conversationId })],
      ["reply", (service: ConversationOwnershipService) => service.reply(fox, { conversationId, message: "Hi" })],
    ] as const)("fails the %s, telling no one, when its held replies cannot be superseded", async (_command, command) => {
      const failure = new Error("held replies unavailable");
      const { service, heldReplies, audit, publisher, replies } = createService();
      heldReplies.supersedePendingForConversation.mockRejectedValue(failure);

      await expect(command(service)).rejects.toThrow(failure);

      expect(replies.write).not.toHaveBeenCalled();
      expect(replies.announce).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(publisher.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("requestHumanOwnership", () => {
    // The caller's unit of work: its own transaction-bound ownership and activity writers.
    const createScope = (ownership: InMemoryConversationOwnershipRepository) => {
      const recorded: ConversationActivityEvent[] = [];
      return {
        recorded,
        scope: {
          ownership: { requestHandoff: vi.fn((input: Parameters<typeof ownership.requestHandoff>[0]) => ownership.requestHandoff(input)) },
          activity: { record: vi.fn(async (event: ConversationActivityEvent) => { recorded.push(event); }) },
        },
      };
    };

    it("writes human_owned with the reason and a handoff_requested activity in the caller's scope", async () => {
      const { service, ownership, activity, publisher, audit } = createService();
      const { scope, recorded } = createScope(ownership);

      const result = await service.requestHumanOwnership(scope, {
        conversationId,
        workspaceId,
        reason: "operator_only_mailbox",
      });

      expect(result).toMatchObject({
        changed: true,
        record: { state: "human_owned", reason: "operator_only_mailbox", ownerUserId: null, version: 1 },
      });
      expect(scope.ownership.requestHandoff).toHaveBeenCalledWith({ conversationId, workspaceId, reason: "operator_only_mailbox" });
      expect(recorded).toEqual([{
        kind: "handoff_requested",
        conversationId,
        workspaceId,
        actorUserId: null,
        detail: { reason: "operator_only_mailbox" },
      }]);
      // Inside the caller's transaction: the service opens no unit of work of its own, and tells
      // nobody before the caller has committed.
      expect(activity.record).not.toHaveBeenCalled();
      expect(publisher.enqueue).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("hands a conversation the AI owns again back to a person", async () => {
      const { service, ownership } = createService();
      const claim = await service.takeOver(dana, { conversationId });
      await service.handBack(dana, { conversationId, expectedVersion: claim.record!.version });
      const { scope, recorded } = createScope(ownership);

      const result = await service.requestHumanOwnership(scope, { conversationId, workspaceId, reason: "generation_budget" });

      expect(result).toMatchObject({
        changed: true,
        record: { state: "human_owned", reason: "generation_budget", ownerUserId: null, version: 3 },
      });
      expect(recorded.map((event) => event.kind)).toEqual(["handoff_requested"]);
    });

    it("changes nothing and records nothing when a person already owns the conversation", async () => {
      const { service, ownership } = createService();
      await service.takeOver(dana, { conversationId });
      const { scope, recorded } = createScope(ownership);

      const result = await service.requestHumanOwnership(scope, { conversationId, workspaceId, reason: "review_unavailable" });

      expect(result).toMatchObject({
        changed: false,
        record: { state: "human_owned", ownerUserId: "user-dana", version: 1 },
      });
      expect(result.record.reason).not.toBe("review_unavailable");
      expect(recorded).toEqual([]);
    });

    it("fails, so the caller's transaction rolls back, when the activity cannot be written", async () => {
      const { service, ownership } = createService();
      const { scope } = createScope(ownership);
      scope.activity.record.mockRejectedValueOnce(new Error("activity unavailable"));

      await expect(service.requestHumanOwnership(scope, { conversationId, workspaceId, reason: "operator_only_mailbox" }))
        .rejects.toThrow("activity unavailable");
    });
  });
});
