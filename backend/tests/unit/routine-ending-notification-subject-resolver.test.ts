import { describe, expect, it, vi } from "vitest";

import { RepositoryRoutineEndingNotificationSubjectResolver } from "../../src/modules/chat/services/actions/routineEndingNotificationSubjectResolver.js";

describe("RepositoryRoutineEndingNotificationSubjectResolver", () => {
  const routineId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const input = { workspaceId: "ws_1", routineId, conversationId: "conv_1" };

  it("resolves the names, the routine's declared slot order, and the stored entry page of the conversation", async () => {
    const conversations = { findByIdAndWorkspaceId: vi.fn(async () => ({ agentId: "agent_1", entryPageUrl: "https://ananda.example/stays" })) };
    const agents = { findByIdAndWorkspaceId: vi.fn(async () => ({ name: "Retreat desk" })) };
    const routines = { findById: vi.fn(async () => ({ name: "Book accommodation", slots: [{ key: "guest_name" }, { key: "arrival_date" }, { key: "nights" }] })) };
    const resolver = new RepositoryRoutineEndingNotificationSubjectResolver(
      agents,
      routines,
      conversations,
    );

    expect(await resolver.resolve(input)).toEqual({
      agentId: "agent_1",
      agentName: "Retreat desk",
      routineName: "Book accommodation",
      routineSlotKeys: ["guest_name", "arrival_date", "nights"],
      conversation: { entryPageUrl: "https://ananda.example/stays" },
    });
    expect(conversations.findByIdAndWorkspaceId).toHaveBeenCalledWith("conv_1", "ws_1");
    expect(agents.findByIdAndWorkspaceId).toHaveBeenCalledWith("agent_1", "ws_1");
    expect(routines.findById).toHaveBeenCalledWith("agent_1", routineId);
  });

  it("leaves out what it cannot find instead of failing the notice", async () => {
    const resolver = new RepositoryRoutineEndingNotificationSubjectResolver(
      { findByIdAndWorkspaceId: async () => null },
      { findById: async () => null },
      { findByIdAndWorkspaceId: async () => null },
    );

    expect(await resolver.resolve(input)).toEqual({ agentId: null, agentName: null, routineName: null });
  });

  it("does not look up an agent or routine when the trusted conversation has no agent", async () => {
    const agents = { findByIdAndWorkspaceId: vi.fn(async () => ({ name: "Unused" })) };
    const routines = { findById: vi.fn(async () => ({ name: "Unused", slots: [] })) };
    const resolver = new RepositoryRoutineEndingNotificationSubjectResolver(
      agents,
      routines,
      { findByIdAndWorkspaceId: async () => ({ agentId: null, entryPageUrl: null }) },
    );

    expect(await resolver.resolve(input)).toEqual({
      agentId: null,
      agentName: null,
      routineName: null,
      conversation: { entryPageUrl: null },
    });
    expect(agents.findByIdAndWorkspaceId).not.toHaveBeenCalled();
    expect(routines.findById).not.toHaveBeenCalled();
  });

  it("never queries a routine id that is not a uuid", async () => {
    const routines = { findById: vi.fn(async () => ({ name: "Unused", slots: [] })) };
    const resolver = new RepositoryRoutineEndingNotificationSubjectResolver(
      { findByIdAndWorkspaceId: async () => ({ name: "Retreat desk" }) },
      routines,
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1", entryPageUrl: null }) },
    );

    expect(await resolver.resolve({ ...input, routineId: "unknown" })).toEqual(expect.objectContaining({
      agentId: "agent_1",
      routineName: null,
    }));
    expect(routines.findById).not.toHaveBeenCalled();
  });

  it("drops the agent and routine when the conversation's agent is not in the workspace", async () => {
    const resolver = new RepositoryRoutineEndingNotificationSubjectResolver(
      { findByIdAndWorkspaceId: async () => null },
      { findById: async () => ({ name: "Other workspace routine", slots: [{ key: "secret" }] }) },
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_elsewhere", entryPageUrl: null }) },
    );

    expect(await resolver.resolve(input)).toEqual({
      agentId: null,
      agentName: null,
      routineName: null,
      conversation: { entryPageUrl: null },
    });
  });
});
