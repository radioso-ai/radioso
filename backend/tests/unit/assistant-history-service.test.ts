import { describe, expect, it, vi } from "vitest";

import { AssistantHistoryService } from "../../src/modules/chat/services/assistantHistoryService.js";
import type { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";

// The operator/public split for shared read methods lives entirely in this facade:
// the dashboard route goes through AssistantHistoryService, the public/embed route
// calls ChatHistoryService directly and never sets these options. This test is the
// regression guard for that gate — if a dashboard-only option is dropped from the
// options object below, operators silently lose the feature it gates.
describe("AssistantHistoryService", () => {
  it("reads conversation detail with every dashboard-only option enabled", async () => {
    const getConversation = vi.fn(async () => ({}) as never);
    const chatHistoryService = { getConversation } as unknown as ChatHistoryService;
    const service = new AssistantHistoryService(chatHistoryService);

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

  it("reads a contact request's conversation with the same dashboard-only options", async () => {
    const getConversation = vi.fn(async () => ({}) as never);
    const chatHistoryService = {
      getConversation,
      getContactRequest: vi.fn(async () => ({}) as never),
    } as unknown as ChatHistoryService;
    const service = new AssistantHistoryService(chatHistoryService);

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

  it("tails a conversation with ownership, the replying teammate's label, and the activity since the caller's cursor", async () => {
    const tailConversation = vi.fn(async () => ({}) as never);
    const chatHistoryService = { tailConversation } as unknown as ChatHistoryService;
    const service = new AssistantHistoryService(chatHistoryService);

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
      { includeOwnership: true, includeOperatorLabel: true, activity: { includeFeedback: false } },
    );
  });
});
