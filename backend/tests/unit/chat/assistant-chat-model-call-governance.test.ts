import { describe, expect, it, vi } from "vitest";

import { AssistantChatService } from "../../../src/modules/chat/composition.js";
import {
  currentModelCallGovernance,
  ModelCallGovernor,
  type ModelCallGovernanceScope,
} from "../../../src/shared/infra/llm/modelCallGovernance.js";

const governor = () => new ModelCallGovernor({
  limits: { maxConcurrentTurnCalls: 4, maxConcurrentDeferrableCalls: 1, maxQueueWaitMs: 100 },
  retryPolicy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000 },
});

const answerPayload = {
  conversationId: "conversation-1",
  agentId: "agent-1",
  answer: "Answer",
  citations: [],
  answerSegments: [],
  suggestions: [],
  activitySummary: {},
  route: { type: "direct", reason: "social_only" },
};

describe("AssistantChatService model call governance", () => {
  it("runs a turn's model calls in the turn lane, abandoned when the caller's client disconnects", async () => {
    const scopes: Array<ModelCallGovernanceScope | undefined> = [];
    const chatService = {
      answer: vi.fn(async () => {
        scopes.push(currentModelCallGovernance());
        return answerPayload;
      }),
    };
    const modelCallGovernor = governor();
    const clientDisconnected = new AbortController().signal;
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, {
      modelCallGovernor,
    });

    await service.answer({ workspaceId: "workspace-1", agentId: "agent-1", message: "Question", stream: false, clientDisconnected });

    expect(scopes).toEqual([{ governor: modelCallGovernor, lane: "turn", abandoned: clientDisconnected }]);
  });

  it("keeps the scope on every step of a streamed turn", async () => {
    const lanes: Array<string | undefined> = [];
    const chatService = {
      streamAnswer: vi.fn(async function* () {
        lanes.push(currentModelCallGovernance()?.lane);
        yield { type: "status", stage: "interpreting" };
        await Promise.resolve();
        lanes.push(currentModelCallGovernance()?.lane);
        yield { type: "status", stage: "composing" };
      }),
    };
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, {
      modelCallGovernor: governor(),
    });

    for await (const _event of service.streamAnswer({ workspaceId: "workspace-1", agentId: "agent-1", message: "Question", stream: true })) {
      // drain
    }

    expect(lanes).toEqual(["turn", "turn"]);
  });

  it("governs the proactive greeting too", async () => {
    let lane: string | undefined;
    const chatBootstrapService = {
      startConversation: vi.fn(async () => {
        lane = currentModelCallGovernance()?.lane;
        return null;
      }),
    };
    const service = new AssistantChatService({} as never, chatBootstrapService as never, { modelCallGovernor: governor() });

    await service.answer({ workspaceId: "workspace-1", agentId: "agent-1", startConversation: true, stream: false });

    expect(lane).toBe("turn");
  });

  it("leaves turns ungoverned when composition wires no governor", async () => {
    let scope: ModelCallGovernanceScope | undefined = {} as ModelCallGovernanceScope;
    const chatService = {
      answer: vi.fn(async () => {
        scope = currentModelCallGovernance();
        return answerPayload;
      }),
    };
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never);

    await service.answer({ workspaceId: "workspace-1", agentId: "agent-1", message: "Question", stream: false });

    expect(scope).toBeUndefined();
  });
});
