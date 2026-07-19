import { describe, expect, it } from "vitest";

import { RoutineChatModelGateway } from "../../src/modules/chat/services/routines/routineChatModelGateway.js";
import { CHAT_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import type { ChatGateway, ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";

const turnContext = {
  workspaceContext: { workspaceId: "ws_1" },
  usageContext: {
    accountId: null,
    workspaceId: "ws_1",
    conversationId: "conv_1",
    messageId: "msg_1",
    surface: "assistant" as const,
    operation: "answer" as const,
    attemptKey: "routine_turn",
  },
};

describe("RoutineChatModelGateway", () => {
  it("serializes the transcript into the prompt and forwards the turn's usage + workspace context", async () => {
    const calls: ChatGatewayInput[] = [];
    const chatGateway: Pick<ChatGateway, "answer"> = {
      async answer(input) {
        calls.push(input);
        return "  Sure — what is your email?  ";
      },
    };
    const gateway = new RoutineChatModelGateway(chatGateway, turnContext);

    const result = await gateway.complete({
      messages: [
        { role: "assistant", content: "How can I help?" },
        { role: "user", content: "I want a human to call me" },
      ],
      systemPrompt: "ROUTINE STEP INSTRUCTIONS",
    });

    expect(result.text).toBe("  Sure — what is your email?  ");
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.prompt).toBe("assistant: How can I help?\nuser: I want a human to call me");
    expect(input.query).toBe("I want a human to call me");
    expect(input.systemPrompt).toBe("ROUTINE STEP INSTRUCTIONS");
    expect(input.usageContext).toBe(turnContext.usageContext);
    expect(input.workspaceContext).toBe(turnContext.workspaceContext);
  });

  it("uses a cheap routine_activation usage label and generation budget for activation ranking", async () => {
    const calls: ChatGatewayInput[] = [];
    const chatGateway: Pick<ChatGateway, "answer"> = {
      async answer(input) {
        calls.push(input);
        return '{"matches":[]}';
      },
    };
    const gateway = new RoutineChatModelGateway(chatGateway, turnContext);

    await gateway.complete({
      messages: [{ role: "user", content: "Can I book a demo?" }],
      systemPrompt: "ROUTINE ACTIVATION",
      metadata: { routineActivation: true },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      query: "Can I book a demo?",
      prompt: "user: Can I book a demo?",
      usageContext: {
        ...turnContext.usageContext,
        operation: "routine_activation",
        attemptKey: "routine_activation",
      },
      generation: CHAT_BEHAVIOR.intentRouting,
    });
  });

  it("forwards the turn cancellation signal to routine model calls", async () => {
    const calls: ChatGatewayInput[] = [];
    const controller = new AbortController();
    const gateway = new RoutineChatModelGateway({
      async answer(input) {
        calls.push(input);
        return "Done";
      },
    }, { ...turnContext, signal: controller.signal });

    await gateway.complete({ messages: [{ role: "user", content: "Continue" }] });

    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
