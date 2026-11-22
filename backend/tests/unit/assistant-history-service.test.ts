import { describe, expect, it, vi } from "vitest";

import { AssistantHistoryService } from "../../src/modules/chat/services/assistantHistoryService.js";
import type { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import type { ConversationAttribute, ConversationAttributeReader } from "../../src/modules/context-variables/public.js";

const topicAttribute: ConversationAttribute = {
  name: "topic",
  valueType: "enum",
  value: "billing",
  option: { label: "Billing", archived: false },
  redacted: false,
  scope: "conversation",
  writtenBy: { kind: "classifier", ref: "context-classification/1" },
  updatedAt: new Date("2026-11-20T10:00:00.000Z"),
};

const attributeReader = (): ConversationAttributeReader & { read: ReturnType<typeof vi.fn>; resolveFilter: ReturnType<typeof vi.fn> } => ({
  read: vi.fn(async () => [topicAttribute]),
  resolveFilter: vi.fn(async () => ({ variableId: "topic-id", key: "billing" })),
});

// The operator/public split for shared read methods lives entirely in this facade:
// the dashboard route goes through AssistantHistoryService, the public/embed route
// calls ChatHistoryService directly and never sets these options. This test is the
// regression guard for that gate — if a dashboard-only option is dropped from the
// options object below, operators silently lose the feature it gates.
describe("AssistantHistoryService", () => {
  it("reads conversation detail with every dashboard-only option enabled", async () => {
    const getConversation = vi.fn(async () => ({}) as never);
    const chatHistoryService = { getConversation } as unknown as ChatHistoryService;
    const service = new AssistantHistoryService(chatHistoryService, attributeReader());

    await service.getConversation("workspace-1", "conversation-1", { limit: 50 }, { includeFeedback: false });

    expect(getConversation).toHaveBeenCalledWith(
      "workspace-1",
      "conversation-1",
      { limit: 50 },
      {
        includeAnswerFeedback: true,
        includeOwnership: true,
        includeAgentInternalName: true,
        includeTurnFailureDebug: true,
        includeOperatorLabel: true,
        activity: { includeFeedback: false },
      },
    );
  });

  it("reads a conversation's attributes beside its detail", async () => {
    const chatHistoryService = { getConversation: vi.fn(async () => ({ conversationId: "conversation-1" }) as never) } as unknown as ChatHistoryService;
    const attributes = attributeReader();
    const service = new AssistantHistoryService(chatHistoryService, attributes);

    await expect(service.getConversation("workspace-1", "conversation-1", { limit: 50 }, { includeFeedback: false }))
      .resolves.toEqual({ conversationId: "conversation-1", attributes: [topicAttribute] });
    expect(attributes.read).toHaveBeenCalledWith("workspace-1", "conversation-1");
  });

  it("resolves an attribute filter before either history list reads, and lists unfiltered without one", async () => {
    const chatHistoryService = {
      listItems: vi.fn(async () => ({}) as never),
      listConversations: vi.fn(async () => ({}) as never),
    } as unknown as ChatHistoryService;
    const attributes = attributeReader();
    const service = new AssistantHistoryService(chatHistoryService, attributes);

    await service.listItems("workspace-1", { limit: 20, outcome: "handed_off", attribute: { name: "topic", option: "billing" } });
    await service.listConversations("workspace-1", { limit: 20, attribute: { name: "topic", option: "billing" } });
    await service.listItems("workspace-1", { limit: 20 });

    expect(attributes.resolveFilter).toHaveBeenCalledTimes(2);
    expect(attributes.resolveFilter).toHaveBeenCalledWith("workspace-1", { name: "topic", option: "billing" });
    expect(chatHistoryService.listItems).toHaveBeenNthCalledWith(1, "workspace-1", {
      limit: 20, outcome: "handed_off", attribute: { variableId: "topic-id", key: "billing" },
    });
    expect(chatHistoryService.listConversations).toHaveBeenCalledWith("workspace-1", {
      limit: 20, attribute: { variableId: "topic-id", key: "billing" },
    });
    expect(chatHistoryService.listItems).toHaveBeenNthCalledWith(2, "workspace-1", { limit: 20 });
  });

  it("reads a contact request's conversation with the same dashboard-only options", async () => {
    const getConversation = vi.fn(async () => ({}) as never);
    const chatHistoryService = {
      getConversation,
      getContactRequest: vi.fn(async () => ({}) as never),
    } as unknown as ChatHistoryService;
    const service = new AssistantHistoryService(chatHistoryService, attributeReader());

    await service.getContactRequest("workspace-1", "contact-1", { limit: 50 }, { includeFeedback: true });

    expect(chatHistoryService.getContactRequest).toHaveBeenCalledWith(
      "workspace-1",
      "contact-1",
      { limit: 50 },
      {
        includeAnswerFeedback: true,
        includeOwnership: true,
        includeAgentInternalName: true,
        includeTurnFailureDebug: true,
        includeOperatorLabel: true,
        activity: { includeFeedback: true },
      },
    );
  });

  it("tails a conversation with ownership, the replying teammate's label, the activity since the caller's cursor, and the replies marked interrupted since it", async () => {
    const tailConversation = vi.fn(async () => ({}) as never);
    const chatHistoryService = { tailConversation } as unknown as ChatHistoryService;
    const service = new AssistantHistoryService(chatHistoryService, attributeReader());

    await service.tailConversation(
      "workspace-1",
      "conversation-1",
      { limit: 20, activityCursor: "77777777-7777-4777-8777-777777777777" },
      { includeFeedback: false },
    );

    expect(tailConversation).toHaveBeenCalledWith(
      "workspace-1",
      "conversation-1",
      { limit: 20, activityCursor: "77777777-7777-4777-8777-777777777777" },
      { includeOwnership: true, includeOperatorLabel: true, activity: { includeFeedback: false }, redeliverMarkedReplies: true },
    );
  });
});
