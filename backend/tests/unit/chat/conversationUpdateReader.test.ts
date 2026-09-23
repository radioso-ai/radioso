import { describe, expect, it, vi } from "vitest";

import { createConversationUpdateReader } from "../../../src/modules/chat/services/conversationUpdateReader.js";
import type { ChatConversationTail } from "../../../src/modules/chat/services/chatHistoryService.js";

const tail = (overrides: Partial<ChatConversationTail> = {}): ChatConversationTail => ({
  messages: [],
  cursor: null,
  ...overrides,
});

const turn = (overrides: Partial<ChatConversationTail["messages"][number]>): ChatConversationTail["messages"][number] => ({
  id: "message-1",
  role: "assistant",
  source: "ai_agent",
  content: "Hello",
  createdAt: "2026-09-22T10:00:00.000Z",
  ...overrides,
});

const historyWith = (result: ChatConversationTail) => ({
  tailConversation: vi.fn().mockResolvedValue(result),
});

describe("conversation update reader", () => {
  it("reports an operator reply as a human author even though its role is assistant", async () => {
    const history = historyWith(tail({
      messages: [turn({ id: "m-1", role: "assistant", source: "human_agent", content: "I can refund that." })],
      cursor: "cursor-1",
    }));
    const reader = createConversationUpdateReader({ history });

    const page = await reader.read({ workspaceId: "w-1", conversationId: "c-1", limit: 50 });

    expect(page.messages).toEqual([{
      id: "m-1",
      author: "human",
      createdAt: "2026-09-22T10:00:00.000Z",
      text: "I can refund that.",
    }]);
    expect(page.cursor).toBe("cursor-1");
  });

  it("reports an operator reply sent on behalf of the AI as a human author too", async () => {
    const history = historyWith(tail({
      messages: [turn({ id: "m-2", source: "human_agent_on_behalf_of_ai_agent" })],
    }));
    const reader = createConversationUpdateReader({ history });

    const page = await reader.read({ workspaceId: "w-1", conversationId: "c-1", limit: 50 });

    expect(page.messages[0]?.author).toBe("human");
  });

  it("reports every other source as the agent", async () => {
    const history = historyWith(tail({
      messages: [
        turn({ id: "m-3", role: "user", source: "customer", content: "Where is my order?" }),
        turn({ id: "m-4", role: "assistant", source: "ai_agent", content: "Checking." }),
        turn({ id: "m-5", role: "system", source: "system", content: "Handed off." }),
      ],
    }));
    const reader = createConversationUpdateReader({ history });

    const page = await reader.read({ workspaceId: "w-1", conversationId: "c-1", limit: 50 });

    expect(page.messages.map((message) => message.author)).toEqual(["agent", "agent", "agent"]);
  });

  it("defaults ownership to ai_owned when the tail reports none", async () => {
    const history = historyWith(tail({ messages: [turn({})] }));
    const reader = createConversationUpdateReader({ history });

    const page = await reader.read({ workspaceId: "w-1", conversationId: "c-1", limit: 50 });

    expect(page.ownership).toEqual({ state: "ai_owned" });
  });

  it("reports a human-owned conversation by state alone, with no turn-scoped suppression fact", async () => {
    const history = historyWith(tail({
      messages: [],
      ownership: {
        conversationId: "c-1",
        workspaceId: "w-1",
        state: "human_owned",
        ownerAccountId: "account-1",
        ownerDisplayName: "Dana",
        reason: "operator_takeover",
        version: 1,
        takenOverAt: "2026-09-22T09:59:00.000Z",
        createdAt: "2026-09-22T09:59:00.000Z",
        updatedAt: "2026-09-22T09:59:00.000Z",
      },
    }));
    const reader = createConversationUpdateReader({ history });

    const page = await reader.read({ workspaceId: "w-1", conversationId: "c-1", limit: 50 });

    expect(page.ownership).toEqual({ state: "human_owned" });
  });

  it("asks the history tail for ownership and passes the cursor through", async () => {
    const history = historyWith(tail({}));
    const reader = createConversationUpdateReader({ history });

    await reader.read({ workspaceId: "w-1", conversationId: "c-1", cursor: "opaque-1", limit: 25 });

    expect(history.tailConversation).toHaveBeenCalledWith(
      "w-1",
      "c-1",
      { cursor: "opaque-1", limit: 25 },
      { includeOwnership: true },
    );
  });
});
