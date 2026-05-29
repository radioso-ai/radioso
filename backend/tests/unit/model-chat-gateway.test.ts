import { describe, expect, it } from "vitest";

import { ModelChatGateway } from "../../src/modules/chat/services/chatService.js";
import type {
  TextGenerationClient,
  TextGenerationRequest,
} from "../../src/shared/infra/llm/providerTypes.js";
import { streamResult, textResult } from "../support/llmStubs.js";

describe("ModelChatGateway", () => {
  it("passes system prompts through to non-streaming generation", async () => {
    const requests: TextGenerationRequest[] = [];
    const gateway = new ModelChatGateway({
      metadata: { capability: "chat", provider: "openai-compatible", model: "test-chat" },
      async complete(input) {
        requests.push(input);
        return textResult("Answer");
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient);

    await gateway.answer({
      query: "Question",
      history: [],
      systemPrompt: "System instructions",
      prompt: "User prompt",
    });

    expect(requests).toEqual([
      {
        systemPrompt: "System instructions",
        prompt: "User prompt",
      },
    ]);
  });

  it("passes system prompts through to streaming generation", async () => {
    const requests: TextGenerationRequest[] = [];
    const gateway = new ModelChatGateway({
      metadata: { capability: "chat", provider: "openai-compatible", model: "test-chat" },
      async complete() {
        return textResult("Answer");
      },
      stream(input) {
        requests.push(input);
        return streamResult(["A", "B"]);
      },
    } satisfies TextGenerationClient);

    const chunks: string[] = [];
    for await (const chunk of gateway.streamAnswer({
      query: "Question",
      history: [],
      systemPrompt: "System instructions",
      prompt: "User prompt",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["A", "B"]);
    expect(requests).toEqual([
      {
        systemPrompt: "System instructions",
        prompt: "User prompt",
      },
    ]);
  });
});
