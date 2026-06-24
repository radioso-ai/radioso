import { describe, expect, it, vi } from "vitest";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";

import { OperatorReplyService } from "../../src/modules/handoff/public.js";

const conversation: ConversationRecord = {
  id: "conversation-1",
  workspaceId: "workspace-1",
  agentId: null,
  agentName: null,
  sourceChannel: "authenticated_chat",
  sourceOrigin: null,
  channelContext: null,
  anonymousSessionId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

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
    const service = new OperatorReplyService({
      conversationRepository,
      messageRepository,
      auditService,
      publicConversationEventBus,
      customerReplyDelivery: delivery,
    });

    const result = await service.reply({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      accountId: "account-1",
      displayName: "Dana",
      message: "Human reply",
    });

    expect(result).toBe(message);
    expect(messageRepository.create).toHaveBeenCalledWith({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      role: "assistant",
      source: "human_agent",
      content: "Human reply",
      operatorAccountId: "account-1",
      operatorDisplayName: "Dana",
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
});
