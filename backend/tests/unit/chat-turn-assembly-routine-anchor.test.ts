import type { RoutineState } from "@radioso/conversation-contract";
import { describe, expect, it, vi } from "vitest";

import { ChatTurnAssembly } from "../../src/modules/chat/services/chatTurnAssembly.js";

describe("ChatTurnAssembly routine start anchors", () => {
  it("seeds a coverage-activated routine with the current visitor message", async () => {
    const durableStore = {
      loadActive: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const session = {
      conversation: { id: "conversation", workspaceId: "workspace" },
      agent: { id: "agent", workspaceId: "workspace" },
      userMessage: { id: "activation-message" },
    };
    const assembly = new ChatTurnAssembly({
      coverageHeadRecorder: { createReactionRecorder: () => ({ record: async () => {} }) },
      chatGateway: { answer: async () => "{}" },
      routineStore: durableStore,
      routineProvider: {
        forTurn: async () => ({
          coverageActivator: { evaluateCandidates: () => [], activate: async () => null },
          activator: { activate: async () => null },
          runner: { resume: async () => ({ response: { answer: "" }, nextState: null }) },
        }),
      },
    } as never);
    const runtime = await (assembly as unknown as {
      coverageTurnRuntime(sessionInput: unknown, input: unknown): Promise<unknown>;
    }).coverageTurnRuntime(session, {
      responseLanguage: Promise.resolve(undefined),
      getSession: () => session,
    });
    const captured = runtime as {
      routineStore: { save(state: RoutineState): Promise<void> };
      effects(result: unknown): { commitRoutineState(): Promise<void> };
    };

    await captured.routineStore.save({
      sessionId: "conversation",
      routineId: "routine",
      executionId: "execution",
      path: [],
      variables: {},
      status: "active",
    });
    await captured.effects({ actions: [], trace: {} }).commitRoutineState();

    expect(durableStore.save).toHaveBeenCalledWith(expect.objectContaining({
      startedMessageId: "activation-message",
    }));
  });
});
