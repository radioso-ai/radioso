import { describe, expect, it, vi } from "vitest";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";

import { OperatorReplyService, type OperatorIdentity } from "../../src/modules/handoff/public.js";

const conversation: ConversationRecord = {
  id: "conversation-1",
  workspaceId: "workspace-1",
  agentId: null,
  purpose: "production",
  agentName: null,
  agentInternalName: null,
  sourceChannel: "authenticated_chat",
  callerKind: "human" as const,
  sourceOrigin: null,
  channelContext: null,
  anonymousSessionId: null,
  verifiedCustomerId: null,
  entryPageUrl: null,
  title: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const dana: OperatorIdentity = { userId: "user-1", teammateLabel: "Dana Scully", replySignature: "Dana Scully" };

const replyFrom = (operator: OperatorIdentity = dana) => ({
  conversation,
  accountId: "account-1",
  operator,
  message: "Human reply",
});

const savedMessage = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
  id: "message-1",
  conversationId: conversation.id,
  workspaceId: conversation.workspaceId,
  role: "assistant",
  source: "human_agent",
  content: "Human reply",
  createdAt: new Date("2026-01-01T00:00:01Z"),
  ...overrides,
});

const writeScope = (message: MessageRecord = savedMessage()) => {
  const order: string[] = [];
  return {
    order,
    messages: { create: vi.fn(async () => { order.push("message"); return message; }) },
    conversations: { touch: vi.fn(async () => { order.push("touch"); }) },
    outbox: {
      enqueue: vi.fn(async (_request: { type: string; payload: Record<string, unknown> }) => {
        order.push("outbox");
        return { id: "action-1", duplicate: false };
      }),
    },
  };
};

type ReplyDependencies = ConstructorParameters<typeof OperatorReplyService>[0];

const createService = (overrides: Partial<Pick<ReplyDependencies, "auditService" | "customerReplyDelivery" | "publicConversationEventBus" | "publisher">> = {}) => {
  const logger = { warn: vi.fn() };
  const errorReporter = { report: vi.fn(async () => undefined) };
  const dependencies = {
    auditService: { record: vi.fn(async () => undefined) },
    publicConversationEventBus: { publish: vi.fn() },
    customerReplyDelivery: { route: vi.fn(async () => null) },
    ...overrides,
  };
  return { service: new OperatorReplyService({ ...dependencies, logger, errorReporter }), ...dependencies, logger, errorReporter };
};

describe("OperatorReplyService", () => {
  it("resolves the reply's channel route before anything is written", async () => {
    const route = { enqueue: vi.fn(async () => undefined) };
    const { service, customerReplyDelivery } = createService({ customerReplyDelivery: { route: vi.fn(async () => route) } });

    const prepared = await service.prepare(replyFrom());

    expect(customerReplyDelivery.route).toHaveBeenCalledWith(conversation);
    expect(prepared).toEqual({ ...replyFrom(), channel: route });
    expect(route.enqueue).not.toHaveBeenCalled();
  });

  it("writes a human_agent message attributed to the teammate and signed, then dates the conversation, in the caller's scope", async () => {
    const { service } = createService();
    const scope = writeScope();

    const result = await service.write(scope, { ...replyFrom(), channel: null });

    expect(result).toEqual(savedMessage());
    expect(scope.messages.create).toHaveBeenCalledWith({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      role: "assistant",
      source: "human_agent",
      content: "Human reply",
      operatorAccountId: "account-1",
      operatorUserId: "user-1",
      operatorDisplayName: "Dana Scully",
    });
    expect(scope.conversations.touch).toHaveBeenCalledWith(conversation.id, conversation.workspaceId);
    expect(scope.outbox.enqueue).not.toHaveBeenCalled();
  });

  it("queues the reply's channel delivery on the caller's outbox, keyed by the message it wrote", async () => {
    const { service } = createService();
    const scope = writeScope();
    const route = { enqueue: vi.fn(async (outbox: typeof scope.outbox) => { await outbox.enqueue({ type: "slack.post", payload: {} }); }) };

    await service.write(scope, { ...replyFrom(), channel: route });

    expect(route.enqueue).toHaveBeenCalledWith(scope.outbox, { id: "message-1", content: "Human reply" });
    expect(scope.order).toEqual(["message", "touch", "outbox"]);
  });

  it("fails the write when the channel delivery cannot be queued, so the caller's transaction rolls back", async () => {
    const { service } = createService();
    const scope = writeScope();
    const route = { enqueue: vi.fn(async () => { throw new Error("outbox unavailable"); }) };

    await expect(service.write(scope, { ...replyFrom(), channel: route })).rejects.toThrow("outbox unavailable");
  });

  it("attributes the reply to the teammate but leaves it unsigned when there is no visitor-facing name", async () => {
    const { service } = createService();
    const scope = writeScope();

    await service.write(scope, { ...replyFrom({ userId: "user-2", teammateLabel: "fox@example.com", replySignature: null }), channel: null });

    expect(scope.messages.create).toHaveBeenCalledWith(expect.objectContaining({
      operatorAccountId: "account-1",
      operatorUserId: "user-2",
      operatorDisplayName: undefined,
    }));
    expect(JSON.stringify(scope.messages.create.mock.calls)).not.toContain("fox@example.com");
  });

  it("announces a committed reply to the visitor and the dashboard", () => {
    const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
    const { service, publicConversationEventBus } = createService({ publisher });

    service.announce(replyFrom(), savedMessage());

    expect(publicConversationEventBus.publish).toHaveBeenCalledWith({
      type: "message.created",
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      messageId: "message-1",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(publisher.enqueue).toHaveBeenCalledWith(conversation.workspaceId, ["conversation.turn_committed"]);
  });

  it("never fails a committed reply when announcing it throws, and reports the failure by ids only", () => {
    const failure = new Error("listener failed on Human reply");
    const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
    const { service, logger, errorReporter } = createService({
      publisher,
      publicConversationEventBus: { publish: vi.fn(() => { throw failure; }) },
    });

    expect(() => service.announce(replyFrom(), savedMessage())).not.toThrow();

    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({
      event: "hitl_ownership_notification_failed",
      notification: "visitor_push",
      accountId: "account-1",
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      messageId: "message-1",
      errorClass: "Error",
    }, expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Human reply");
    expect(errorReporter.report).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "hitl.ownership.notification_failed",
      error: failure,
      correlation: { accountId: "account-1", workspaceId: conversation.workspaceId, conversationId: conversation.id },
    }));
  });

  it("audits a committed reply", async () => {
    const { service, auditService } = createService();
    const message = savedMessage();

    await service.audit(replyFrom(), message);

    expect(auditService.record).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: conversation.workspaceId,
      eventType: "hitl.ownership",
      eventStatus: "success",
      metadata: {
        action: "replied",
        actorUserId: "user-1",
        conversationId: conversation.id,
        messageId: message.id,
        messageLength: 11,
      },
    });
  });

  it("never fails a committed reply when its audit record fails, reporting the failure by ids only", async () => {
    const failure = new Error("audit unavailable");
    const { service, logger, errorReporter } = createService({
      auditService: { record: vi.fn(async () => { throw failure; }) },
    });

    await expect(service.audit(replyFrom(), savedMessage())).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "hitl_ownership_audit_failed",
      action: "replied",
      conversationId: conversation.id,
      errorClass: "Error",
    }), expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Human reply");
    expect(errorReporter.report).toHaveBeenCalledWith(expect.objectContaining({ errorType: "hitl.ownership.audit_failed", error: failure }));
  });
});
