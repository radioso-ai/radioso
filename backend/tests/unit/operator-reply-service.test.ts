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

const writeScope = (message: MessageRecord = savedMessage()) => ({
  messages: { create: vi.fn(async () => message) },
  conversations: { touch: vi.fn(async () => undefined) },
});

type ReplyDependencies = ConstructorParameters<typeof OperatorReplyService>[0];

const createService = (overrides: Partial<Pick<ReplyDependencies, "auditService" | "customerReplyDelivery" | "publisher">> = {}) => {
  const logger = { warn: vi.fn() };
  const errorReporter = { report: vi.fn(async () => undefined) };
  const dependencies = {
    auditService: { record: vi.fn(async () => undefined) },
    publicConversationEventBus: { publish: vi.fn() },
    customerReplyDelivery: { deliver: vi.fn(async () => undefined) },
    ...overrides,
  };
  return { service: new OperatorReplyService({ ...dependencies, logger, errorReporter }), ...dependencies, logger, errorReporter };
};

describe("OperatorReplyService", () => {
  it("writes a human_agent message attributed to the teammate and signed, in the caller's scope", async () => {
    const { service } = createService();
    const scope = writeScope();

    const result = await service.write(scope, replyFrom());

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
  });

  it("attributes the reply to the teammate but leaves it unsigned when there is no visitor-facing name", async () => {
    const { service } = createService();
    const scope = writeScope();

    await service.write(scope, replyFrom({ userId: "user-2", teammateLabel: "fox@example.com", replySignature: null }));

    expect(scope.messages.create).toHaveBeenCalledWith(expect.objectContaining({
      operatorAccountId: "account-1",
      operatorUserId: "user-2",
      operatorDisplayName: undefined,
    }));
    expect(JSON.stringify(scope.messages.create.mock.calls)).not.toContain("fox@example.com");
  });

  it("delivers a committed reply: invalidates, audits, tells the visitor, and sends it to the customer channel", async () => {
    const order: string[] = [];
    const publisher = { enqueue: vi.fn(() => { order.push("publish"); return { accepted: true as const, coalesced: false }; }) };
    const { service, auditService, publicConversationEventBus, customerReplyDelivery } = createService({
      auditService: { record: vi.fn(async () => { order.push("audit"); }) },
      customerReplyDelivery: { deliver: vi.fn(async () => { order.push("delivery"); }) },
      publisher,
    });
    const message = savedMessage();

    await service.deliver(replyFrom(), message);

    expect(publisher.enqueue).toHaveBeenCalledWith(conversation.workspaceId, ["conversation.turn_committed"]);
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
    expect(publicConversationEventBus.publish).toHaveBeenCalledWith({
      type: "message.created",
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      messageId: message.id,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(customerReplyDelivery.deliver).toHaveBeenCalledWith({
      conversation,
      message: { id: message.id, content: "Human reply" },
    });
    expect(order).toEqual(["publish", "audit", "delivery"]);
  });

  it("still delivers a committed reply when its audit record fails, reporting the failure by ids only", async () => {
    const failure = new Error("audit unavailable");
    const { service, customerReplyDelivery, logger, errorReporter } = createService({
      auditService: { record: vi.fn(async () => { throw failure; }) },
    });

    await expect(service.deliver(replyFrom(), savedMessage())).resolves.toBeUndefined();

    expect(customerReplyDelivery.deliver).toHaveBeenCalledTimes(1);
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
