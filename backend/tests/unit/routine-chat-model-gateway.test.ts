import { describe, expect, it } from "vitest";

import { BlankChatAnswerError } from "../../src/modules/chat/services/chatAnswerErrors.js";
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
    const input = calls[0];
    expect(input.prompt).toBe("assistant: How can I help?\nuser: I want a human to call me");
    expect(input.query).toBe("I want a human to call me");
    expect(input.systemPrompt).toBe("ROUTINE STEP INSTRUCTIONS");
    expect(input.usageContext).toBe(turnContext.usageContext);
    expect(input.workspaceContext).toBe(turnContext.workspaceContext);
  });

  it("retries a blank completion once, under its own usage attempt", async () => {
    const calls: ChatGatewayInput[] = [];
    const chatGateway: Pick<ChatGateway, "answer"> = {
      async answer(input) {
        calls.push(input);
        if (calls.length === 1) {
          throw new BlankChatAnswerError();
        }
        return '{"condition": 1, "variables": {}}';
      },
    };

    const result = await new RoutineChatModelGateway(chatGateway, turnContext).complete({
      messages: [{ role: "user", content: "si" }],
      systemPrompt: "SELECT",
    });

    expect(result.text).toBe('{"condition": 1, "variables": {}}');
    expect(calls).toHaveLength(2);
    expect(calls[1].usageContext.attemptKey).toBe("routine_turn:blank_retry");
    expect(calls[1].prompt).toBe(calls[0].prompt);
  });

  it("meters the second and later completes in a turn under their own usage attempt", async () => {
    const calls: ChatGatewayInput[] = [];
    const chatGateway: Pick<ChatGateway, "answer"> = {
      async answer(input) {
        calls.push(input);
        return "ok";
      },
    };
    const gateway = new RoutineChatModelGateway(chatGateway, turnContext);

    await gateway.complete({ messages: [{ role: "user", content: "first" }] });
    await gateway.complete({ messages: [{ role: "user", content: "second" }] });

    expect(calls).toHaveLength(2);
    expect(calls[0].usageContext.attemptKey).toBe("routine_turn");
    expect(calls[1].usageContext.attemptKey).toBe("routine_turn:2");
  });

  it("derives the blank retry key from the call's own usage attempt, not the turn's", async () => {
    const calls: ChatGatewayInput[] = [];
    let secondCallAttempts = 0;
    const chatGateway: Pick<ChatGateway, "answer"> = {
      async answer(input) {
        calls.push(input);
        if (calls.length === 1) {
          return "ok";
        }
        secondCallAttempts += 1;
        if (secondCallAttempts === 1) {
          throw new BlankChatAnswerError();
        }
        return "recovered";
      },
    };
    const gateway = new RoutineChatModelGateway(chatGateway, turnContext);

    await gateway.complete({ messages: [{ role: "user", content: "first" }] });
    const result = await gateway.complete({ messages: [{ role: "user", content: "second" }] });

    expect(result.text).toBe("recovered");
    expect(calls).toHaveLength(3);
    expect(calls[1].usageContext.attemptKey).toBe("routine_turn:2");
    expect(calls[2].usageContext.attemptKey).toBe("routine_turn:2:blank_retry");
  });

  it("fails when the retry is blank too, and never retries other errors", async () => {
    const blankTwice: Pick<ChatGateway, "answer"> = {
      answer: async () => {
        throw new BlankChatAnswerError();
      },
    };
    await expect(
      new RoutineChatModelGateway(blankTwice, turnContext).complete({ messages: [{ role: "user", content: "si" }] }),
    ).rejects.toBeInstanceOf(BlankChatAnswerError);

    let attempts = 0;
    const failing: Pick<ChatGateway, "answer"> = {
      answer: async () => {
        attempts += 1;
        throw new Error("provider_timeout");
      },
    };
    await expect(
      new RoutineChatModelGateway(failing, turnContext).complete({ messages: [{ role: "user", content: "si" }] }),
    ).rejects.toThrow("provider_timeout");
    expect(attempts).toBe(1);
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
        // Derived from the gateway's own key, so activation calls in two routine phases
        // of one turn never share a usage key (#1378).
        attemptKey: "routine_turn:routine_activation",
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

  describe("streaming", () => {
    it("offers a stream only when the host gateway can stream", () => {
      const answerOnly: Pick<ChatGateway, "answer"> = { answer: async () => "ok" };
      const streamingHost: Pick<ChatGateway, "answer" | "streamAnswer"> = {
        answer: async () => "ok",
        async *streamAnswer() {
          yield "ok";
        },
      };

      expect(new RoutineChatModelGateway(answerOnly, turnContext).stream).toBeUndefined();
      expect(new RoutineChatModelGateway(streamingHost, turnContext).stream).toBeTypeOf("function");
    });

    const streaming = (deltas: string[]) => {
      const calls: Array<{ via: "answer" | "streamAnswer"; input: ChatGatewayInput }> = [];
      const chatGateway: Pick<ChatGateway, "answer" | "streamAnswer"> = {
        async answer(input) {
          calls.push({ via: "answer", input });
          return "ok";
        },
        async *streamAnswer(input) {
          calls.push({ via: "streamAnswer", input });
          yield* deltas;
        },
      };
      return { calls, chatGateway };
    };
    const collect = async (stream: AsyncIterable<string>): Promise<string[]> => {
      const deltas: string[] = [];
      for await (const delta of stream) {
        deltas.push(delta);
      }
      return deltas;
    };

    it("streams through the host gateway's own receiver (#1179)", async () => {
      // A class-based host whose `streamAnswer` reads instance state through `this`, the way
      // `ModelChatGateway.streamAnswer` reads its inference pipeline. A detached method loses it.
      class ReceiverBoundHost {
        readonly calls: ChatGatewayInput[] = [];
        private readonly deltas = ["Which", " email?"];

        async answer(): Promise<string> {
          return "unused";
        }

        async *streamAnswer(input: ChatGatewayInput): AsyncIterable<string> {
          this.calls.push(input);
          yield* this.deltas;
        }
      }
      const host = new ReceiverBoundHost();

      const deltas = await collect(new RoutineChatModelGateway(host, turnContext).stream!({
        messages: [{ role: "user", content: "reply" }],
      }));

      expect(deltas).toEqual(["Which", " email?"]);
      expect(host.calls).toHaveLength(1);
      expect(host.calls[0]?.usageContext.attemptKey).toBe("routine_turn");
    });

    it("streams through the host gateway with the same request a completion sends", async () => {
      const { calls, chatGateway } = streaming(["Sure", " — what is your email?"]);
      const request = {
        messages: [
          { role: "assistant" as const, content: "How can I help?" },
          { role: "user" as const, content: "I want a human to call me" },
        ],
        systemPrompt: "ROUTINE STEP INSTRUCTIONS",
      };

      const deltas = await collect(new RoutineChatModelGateway(chatGateway, turnContext).stream!(request));
      await new RoutineChatModelGateway(chatGateway, turnContext).complete(request);

      expect(deltas).toEqual(["Sure", " — what is your email?"]);
      expect(calls.map((call) => call.via)).toEqual(["streamAnswer", "answer"]);
      expect(calls[0].input).toEqual(calls[1].input);
      expect(calls[0].input.usageContext).toBe(turnContext.usageContext);
    });

    it("meters a stream under the usage attempt its place in the turn's call order gives it", async () => {
      const { calls, chatGateway } = streaming(["Which email?"]);
      const gateway = new RoutineChatModelGateway(chatGateway, turnContext);

      await gateway.complete({ messages: [{ role: "user", content: "select" }] });
      const reply = gateway.stream!({ messages: [{ role: "user", content: "reply" }] });
      const retry = gateway.stream!({ messages: [{ role: "user", content: "reply" }] });
      await collect(retry);
      await collect(reply);

      expect(calls.map((call) => call.input.usageContext.attemptKey)).toEqual([
        "routine_turn",
        "routine_turn:3",
        "routine_turn:2",
      ]);
    });

    it("forwards the turn cancellation signal to a streamed routine reply", async () => {
      const { calls, chatGateway } = streaming(["Done"]);
      const controller = new AbortController();

      await collect(new RoutineChatModelGateway(chatGateway, { ...turnContext, signal: controller.signal })
        .stream!({ messages: [{ role: "user", content: "Continue" }] }));

      expect(calls[0]?.input.signal).toBe(controller.signal);
    });

    it("streams activation ranking under the routine_activation usage label and generation budget", async () => {
      const { calls, chatGateway } = streaming(["{}"]);

      await collect(new RoutineChatModelGateway(chatGateway, turnContext).stream!({
        messages: [{ role: "user", content: "Can I book a demo?" }],
        metadata: { routineActivation: true },
      }));

      expect(calls[0]?.input).toMatchObject({
        usageContext: { operation: "routine_activation", attemptKey: "routine_turn:routine_activation" },
        generation: CHAT_BEHAVIOR.intentRouting,
      });
    });
  });
});
