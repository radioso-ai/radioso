import { describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "../../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../src/db/repositories/messageRepository.js";
import {
  CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
  ConversationOwnershipService,
  type ConversationOperator,
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

const createService = (options: {
  outbox?: { enqueue: InMemoryActionOutbox["enqueue"] };
  audit?: { record: (event: unknown) => Promise<void> };
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
  const replyScope = { messages: { create: vi.fn() }, conversations: { touch: vi.fn() } };
  const replies = {
    write: vi.fn(async (_scope: unknown, reply: { conversation: ConversationRecord; message: string }): Promise<MessageRecord> => ({
      id: "message-1",
      conversationId: reply.conversation.id,
      workspaceId: reply.conversation.workspaceId,
      role: "assistant",
      source: "human_agent",
      content: reply.message,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })),
    deliver: vi.fn(async () => undefined),
  };
  const loadForUpdate = vi.spyOn(ownership, "loadForUpdate");
  const service = new ConversationOwnershipService({
    conversations,
    ownership,
    transfers: {
      run: (work) => work({ ownership, outbox: options.outbox ?? outbox }),
    },
    replyWrites: {
      run: (work) => work({ ownership, reply: replyScope }),
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
    service, ownership, outbox, audit, publisher, replies, replyScope, conversations, operatorIdentities, loadForUpdate, logger, errorReporter,
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
      expect(replies.write).toHaveBeenCalledWith(replyScope, {
        conversation: conversationRecord,
        accountId,
        operator: { userId: "user-dana", teammateLabel: "Dana Scully", replySignature: null },
        message: "Hello",
      });
      expect(replies.deliver).toHaveBeenCalledWith(replies.write.mock.calls[0][1], expect.objectContaining({ id: "message-1" }));
    });

    it("refuses a teammate's reply while another teammate owns the conversation", async () => {
      const { service, replies } = createService();
      const claim = await service.takeOver(dana, { conversationId });

      const result = await service.reply(fox, { conversationId, message: "Me too", expectedVersion: claim.record!.version });

      expect(result).toMatchObject({ ok: false, refusal: "held_by_teammate", record: { ownerUserId: "user-dana" } });
      expect(replies.write).not.toHaveBeenCalled();
      expect(replies.deliver).not.toHaveBeenCalled();
    });

    it("refuses the owner's reply from a stale view", async () => {
      const { service, replies } = createService();
      await service.takeOver(dana, { conversationId });

      const result = await service.reply(dana, { conversationId, message: "Hello", expectedVersion: 0 });

      expect(result).toMatchObject({ ok: false, refusal: "stale" });
      expect(replies.write).not.toHaveBeenCalled();
    });

    it("decides on the ownership it locked, so a transfer that lands first refuses the reply", async () => {
      const { service, ownership, replies, operatorIdentities } = createService();
      const claim = await service.takeOver(dana, { conversationId });
      // Fox takes the conversation after Dana pressed Send, before her reply is written.
      operatorIdentities.resolve.mockImplementationOnce(async (input: { userId: string }) => {
        await ownership.transfer({
          conversationId, accountId, userId: "user-fox", displayName: "Fox Mulder", expectedVersion: claim.record!.version,
        });
        return { userId: input.userId, teammateLabel: "Dana Scully", replySignature: null };
      });

      const result = await service.reply(dana, { conversationId, message: "Hello", expectedVersion: claim.record!.version });

      expect(result).toMatchObject({ ok: false, refusal: "held_by_teammate", record: { ownerUserId: "user-fox" } });
      expect(replies.write).not.toHaveBeenCalled();
      expect(replies.deliver).not.toHaveBeenCalled();
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
      expect(replies.deliver).toHaveBeenCalledTimes(1);
      expect(publisher.enqueue).toHaveBeenCalledWith(workspaceId, ["conversation.ownership_changed"]);
    });

    it("sends a reply that claimed the conversation even when the claim's audit record fails", async () => {
      const { service, replies } = createService({ audit: { record: async () => { throw new Error("audit unavailable"); } } });

      const result = await service.reply(fox, { conversationId, message: "Hi", expectedVersion: 0 });

      expect(result).toMatchObject({ ok: true, record: { ownerUserId: "user-fox" } });
      expect(replies.deliver).toHaveBeenCalledTimes(1);
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
});
