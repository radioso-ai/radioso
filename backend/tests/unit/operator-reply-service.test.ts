import { describe, expect, it, vi } from "vitest";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";

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

const operatorIdentitiesReturning = (identity: OperatorIdentity = {
  userId: "user-1",
  teammateLabel: "Dana Scully",
  replySignature: "Dana Scully",
}) => ({ resolve: vi.fn(async () => identity) });

describe("OperatorReplyService", () => {
  it("creates a human_agent message, touches, audits, publishes, and delivers", async () => {
    const message = {
      id: "message-1",
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      role: "assistant" as const,
      source: "human_agent" as const,
      content: "Human reply",
      createdAt: new Date("2026-01-01T00:00:01Z"),
    };
    const delivery = { deliver: vi.fn() };
    const conversationRepository = {
      findByIdAndWorkspaceId: vi.fn(async () => conversation),
      touch: vi.fn(),
    };
    const messageRepository = { create: vi.fn(async () => message) };
    const auditService = { record: vi.fn() };
    const publicConversationEventBus = { publish: vi.fn() };
    const operatorIdentities = operatorIdentitiesReturning({
      userId: "user-1",
      teammateLabel: "Dana Scully",
      replySignature: "Dana Scully",
    });
    const service = new OperatorReplyService({
      conversationRepository,
      messageRepository,
      auditService,
      publicConversationEventBus,
      customerReplyDelivery: delivery,
      operatorIdentities,
    });

    const result = await service.reply({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      accountId: "account-1",
      userId: "user-1",
      message: "Human reply",
    });

    expect(result).toBe(message);
    expect(operatorIdentities.resolve).toHaveBeenCalledWith({ accountId: "account-1", userId: "user-1" });
    expect(messageRepository.create).toHaveBeenCalledWith({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      role: "assistant",
      source: "human_agent",
      content: "Human reply",
      operatorAccountId: "account-1",
      operatorUserId: "user-1",
      operatorDisplayName: "Dana Scully",
    });
    expect(conversationRepository.touch).toHaveBeenCalledWith(
      conversation.id,
      conversation.workspaceId,
    );
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-1",
      workspaceId: conversation.workspaceId,
      eventType: "hitl.ownership",
      eventStatus: "success",
      metadata: expect.objectContaining({
        action: "replied",
        actorUserId: "user-1",
        conversationId: conversation.id,
        messageId: message.id,
        messageLength: 11,
      }),
    }));
    expect(publicConversationEventBus.publish).toHaveBeenCalledWith({
      type: "message.created",
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      messageId: message.id,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(delivery.deliver).toHaveBeenCalledWith({
      conversation,
      message: { id: message.id, content: "Human reply" },
    });
  });

  it("publishes a committed operator turn after the message write and stays out of delivery handlers", async () => {
    const message = {
      id: "message-2",
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      role: "assistant" as const,
      source: "human_agent" as const,
      content: "Human reply",
      createdAt: new Date("2026-01-01T00:00:01Z"),
    };
    const order: string[] = [];
    const publisher = {
      enqueue: vi.fn(() => {
        order.push("publish");
        return { accepted: true };
      }),
    };
    const service = new OperatorReplyService({
      conversationRepository: {
        findByIdAndWorkspaceId: vi.fn(async () => conversation),
        touch: vi.fn(async () => { order.push("touch"); }),
      },
      messageRepository: { create: vi.fn(async () => { order.push("message"); return message; }) },
      auditService: { record: vi.fn(async () => { order.push("audit"); }) },
      publicConversationEventBus: { publish: vi.fn() },
      customerReplyDelivery: { deliver: vi.fn(async () => { order.push("delivery"); }) },
      operatorIdentities: operatorIdentitiesReturning(),
      publisher,
    } as never);

    await service.reply({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      accountId: "account-1",
      userId: "user-1",
      message: "Human reply",
    });

    expect(publisher.enqueue).toHaveBeenCalledWith(conversation.workspaceId, ["conversation.turn_committed"]);
    expect(order.indexOf("publish")).toBeGreaterThan(order.indexOf("message"));
    expect(order.indexOf("publish")).toBeLessThan(order.indexOf("delivery"));
  });

  it("keeps the committed-turn publication when secondary audit bookkeeping fails", async () => {
    const publisher = { enqueue: vi.fn(() => ({ accepted: true })) };
    const service = new OperatorReplyService({
      conversationRepository: {
        findByIdAndWorkspaceId: vi.fn(async () => conversation),
        touch: vi.fn(async () => undefined),
      },
      messageRepository: {
        create: vi.fn(async () => ({
          id: "message-3",
          conversationId: conversation.id,
          workspaceId: conversation.workspaceId,
          role: "assistant",
          source: "human_agent",
          content: "Human reply",
          createdAt: new Date(),
        })),
      },
      auditService: { record: vi.fn(async () => { throw new Error("audit unavailable"); }) },
      publicConversationEventBus: { publish: vi.fn() },
      customerReplyDelivery: { deliver: vi.fn() },
      operatorIdentities: operatorIdentitiesReturning(),
      publisher,
    } as never);

    await expect(service.reply({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      accountId: "account-1",
      userId: "user-1",
      message: "Human reply",
    })).rejects.toThrow("audit unavailable");
    expect(publisher.enqueue).toHaveBeenCalledWith(conversation.workspaceId, ["conversation.turn_committed"]);
  });

  it("attributes the reply to the teammate but leaves it unsigned when there is no visitor-facing name", async () => {
    const messageRepository = {
      create: vi.fn(async () => ({
        id: "message-4",
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        role: "assistant" as const,
        source: "human_agent" as const,
        content: "Human reply",
        createdAt: new Date(),
      })),
    };
    const service = new OperatorReplyService({
      conversationRepository: {
        findByIdAndWorkspaceId: vi.fn(async () => conversation),
        touch: vi.fn(async () => undefined),
      },
      messageRepository,
      auditService: { record: vi.fn() },
      publicConversationEventBus: { publish: vi.fn() },
      customerReplyDelivery: { deliver: vi.fn() },
      operatorIdentities: operatorIdentitiesReturning({
        userId: "user-2",
        teammateLabel: "fox@example.com",
        replySignature: null,
      }),
    });

    await service.reply({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      accountId: "account-1",
      userId: "user-2",
      message: "Human reply",
    });

    expect(messageRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      operatorAccountId: "account-1",
      operatorUserId: "user-2",
      operatorDisplayName: undefined,
    }));
    expect(JSON.stringify(messageRepository.create.mock.calls)).not.toContain("fox@example.com");
  });
});
