import { describe, expect, it } from "vitest";
import type { ConversationModelGateway, TurnContext } from "@radioso/conversation-contract";

import { classifyContactIntent } from "../../src/modules/chat/services/routines/contactActivationClassifier.js";

const turn = (content: string): TurnContext => ({
  agent: { id: "a", name: "A" },
  sessionId: "conv_1",
  inputEvent: { kind: "message", content },
  history: [{ role: "assistant", content: "How can I help?" }],
  stagedContext: [],
  steering: [],
});

describe("classifyContactIntent", () => {
  it("returns true when the model judges the user wants a human, passing the transcript", async () => {
    const calls: Parameters<ConversationModelGateway["complete"]>[0][] = [];
    const gateway: ConversationModelGateway = {
      async complete(input) {
        calls.push(input);
        return { text: 'Sure: {"wantsContact": true}' };
      },
    };

    expect(await classifyContactIntent(gateway, turn("I would like to contact a human."))).toBe(true);
    expect(calls[0]!.messages).toEqual([
      { role: "assistant", content: "How can I help?" },
      { role: "user", content: "I would like to contact a human." },
    ]);
    expect(calls[0]!.systemPrompt).toBeTruthy();
  });

  it("returns false when the model declines", async () => {
    const gateway: ConversationModelGateway = { complete: async () => ({ text: '{"wantsContact": false}' }) };
    expect(await classifyContactIntent(gateway, turn("what is your email?"))).toBe(false);
  });

  it("returns false on unparseable output", async () => {
    const gateway: ConversationModelGateway = { complete: async () => ({ text: "no json here" }) };
    expect(await classifyContactIntent(gateway, turn("hello"))).toBe(false);
  });

  it("returns false (never throws) when the model errors", async () => {
    const gateway: ConversationModelGateway = {
      complete: async () => {
        throw new Error("model down");
      },
    };
    expect(await classifyContactIntent(gateway, turn("hello"))).toBe(false);
  });
});
