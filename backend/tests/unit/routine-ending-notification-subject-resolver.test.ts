import { describe, expect, it, vi } from "vitest";

import { RepositoryRoutineEndingNotificationSubjectResolver } from "../../src/modules/chat/services/actions/routineEndingNotificationSubjectResolver.js";

describe("RepositoryRoutineEndingNotificationSubjectResolver", () => {
  const input = { workspaceId: "ws_1", agentId: "agent_1", routineId: "routine_1", conversationId: "conv_1" };

  it("resolves the names and the stored channel and entry page of the conversation", async () => {
    const conversations = { findByIdAndWorkspaceId: vi.fn(async () => ({ sourceChannel: "embed", entryPageUrl: "https://ananda.example/stays" })) };
    const resolver = new RepositoryRoutineEndingNotificationSubjectResolver(
      { findByIdAndWorkspaceId: async () => ({ name: "Retreat desk" }) },
      { findById: async () => ({ name: "Book accommodation" }) },
      conversations,
    );

    expect(await resolver.resolve(input)).toEqual({
      agentName: "Retreat desk",
      routineName: "Book accommodation",
      conversation: { channel: "embed", entryPageUrl: "https://ananda.example/stays" },
    });
    expect(conversations.findByIdAndWorkspaceId).toHaveBeenCalledWith("conv_1", "ws_1");
  });

  it("leaves out what it cannot find instead of failing the notice", async () => {
    const resolver = new RepositoryRoutineEndingNotificationSubjectResolver(
      { findByIdAndWorkspaceId: async () => null },
      { findById: async () => null },
      { findByIdAndWorkspaceId: async () => null },
    );

    expect(await resolver.resolve(input)).toEqual({ agentName: null, routineName: null });
  });
});
