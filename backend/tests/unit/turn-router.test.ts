import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import {
  buildTurnRouterPrompt,
  LlmTurnRouter,
  ModelTurnRouterGateway,
  normalizeTurnRouting,
  parseTurnRouting,
  type TurnRouterGateway,
} from "../../src/modules/chat/services/turnRouter.js";

const message = (content: string, role: MessageRecord["role"] = "user"): MessageRecord => ({
  id: content,
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  role,
  content,
  createdAt: new Date(),
});

describe("TurnRouter", () => {
  it("maps identity questions to direct with identity framing", async () => {
    const router = new LlmTurnRouter(gatewayReturning({
      route: "direct",
      isIdentityQuestion: true,
      intentTopic: "assistant role",
    }));

    await expect(router.classify({
      query: "Who are you?",
      history: [],
      responseIdentity: { name: "Vikram" },
      customInstruction: "Help visitors choose retreats.",
      workspaceContext: { workspaceId: "workspace-1" },
    })).resolves.toEqual({
      route: "direct",
      framing: {
        intentTopic: "assistant role",
        isIdentityQuestion: true,
      },
    });
  });

  it("maps acknowledgements to direct and questions to retrieval", () => {
    expect(normalizeTurnRouting({
      route: "direct",
      isIdentityQuestion: false,
      intentTopic: "gratitude",
    })).toEqual({
      route: "direct",
      framing: {
        intentTopic: "gratitude",
        isIdentityQuestion: false,
      },
    });
    expect(normalizeTurnRouting({
      route: "retrieval",
      inScopeRequest: "Tell me about meditation retreats",
      outsideScopeRequest: "solve a math problem",
    })).toEqual({
      route: "retrieval",
      framing: {
        isIdentityQuestion: false,
      },
    });
  });

  it("routes procedural and vague in-scope requests to retrieval through model behavior", async () => {
    const router = new LlmTurnRouter(gatewayReturning({
      route: "retrieval",
      isIdentityQuestion: false,
      intentTopic: "accepted offered action",
      inScopeRequest: "show the first retreat",
    }));

    const result = await router.classify({
      query: "yes, show me the first one",
      history: [message("I found a retreat and a course. Which should I open?", "assistant")],
      responseIdentity: { name: "Vikram" },
      customInstruction: "Help visitors choose retreats and courses.",
      workspaceContext: { workspaceId: "workspace-1" },
    });

    expect(result.route).toBe("retrieval");
    expect(result.framing.inScopeRequest).toBeUndefined();
    expect(result.framing.outsideScopeRequest).toBeUndefined();
  });

  it("runs the classifier at the cheap intent-routing effort and token ceiling, not answer-grade", async () => {
    let captured: { reasoningEffort?: string; maxOutputTokens?: number } | undefined;
    const inference = {
      metadata: {},
      async complete(request: { reasoningEffort?: string; maxOutputTokens?: number }) {
        captured = request;
        return { text: '{"route":"direct","isIdentityQuestion":false}' };
      },
    };
    const gateway = new ModelTurnRouterGateway(inference as never);

    await gateway.classify({
      query: "thanks",
      contextMessages: [],
      usageContext: { workspaceId: "w", surface: "assistant", operation: "turn_router", attemptKey: "x" },
    });

    expect(captured?.reasoningEffort).toBe(CHAT_BEHAVIOR.intentRouting.reasoningEffort);
    expect(captured?.maxOutputTokens).toBe(CHAT_BEHAVIOR.intentRouting.maxOutputTokens);
  });

  it("strips code fences and parses the classifier JSON, defaulting missing fields", () => {
    expect(parseTurnRouting('```json\n{"route":"direct","isIdentityQuestion":true}\n```')).toMatchObject({
      route: "direct",
      isIdentityQuestion: true,
    });
    expect(parseTurnRouting('{"route":"retrieval"}')).toMatchObject({
      route: "retrieval",
      isIdentityQuestion: false,
    });
  });

  it("ignores scope framing proposed by the classifier", () => {
    const normalized = normalizeTurnRouting({
      route: "retrieval",
      inScopeRequest: "a".repeat(300),
      outsideScopeRequest: "null",
    });
    expect(normalized.framing.inScopeRequest).toBeUndefined();
    expect(normalized.framing.outsideScopeRequest).toBeUndefined();
  });

  it("falls back to retrieval when the classifier gateway throws (fail toward grounding)", async () => {
    const router = new LlmTurnRouter({
      async classify() {
        throw new Error("classifier unavailable");
      },
    });

    await expect(router.classify({ query: "anything", history: [] })).resolves.toEqual({
      route: "retrieval",
      framing: { isIdentityQuestion: false },
    });
  });

  it("keeps custom instructions out of routing and leaves support to retrieval", () => {
    const prompt = buildTurnRouterPrompt({
      context: "ASSISTANT: I can show the retreat.",
      query: "jah, näita seda",
    });

    expect(prompt).not.toContain("Configured response instructions:");
    expect(prompt).toContain("Retrieval evidence decides whether the assistant has support");
    expect(prompt).toContain("Always return null for inScopeRequest and outsideScopeRequest");
    expect(prompt).toContain("Do not rely on English keyword matching");
    expect(prompt).toContain('"route":"retrieval|direct"');
  });
});

const gatewayReturning = (result: Awaited<ReturnType<TurnRouterGateway["classify"]>>): TurnRouterGateway => ({
  async classify() {
    return result;
  },
});
