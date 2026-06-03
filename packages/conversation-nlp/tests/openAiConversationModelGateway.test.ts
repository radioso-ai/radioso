import { describe, expect, it, vi } from "vitest";

import { OpenAIConversationModelGateway, type OpenAIChatClient } from "../src/index.js";

const mockClient = (response: Awaited<ReturnType<OpenAIChatClient["chat"]["completions"]["create"]>>) => ({
  chat: {
    completions: {
      create: vi.fn<OpenAIChatClient["chat"]["completions"]["create"]>(async () => response),
    },
  },
});

describe("OpenAIConversationModelGateway", () => {
  it("maps conversation messages and system prompt to an OpenAI chat completion request", async () => {
    const client = mockClient({
      id: "chatcmpl_test",
      model: "gpt-test",
      choices: [{ message: { content: "  Hello from OpenAI.  " } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    });
    const gateway = new OpenAIConversationModelGateway({
      client,
      model: "gpt-test",
      reasoningEffort: "low",
    });

    const result = await gateway.complete({
      systemPrompt: "Answer as a concise assistant.",
      messages: [
        { role: "user", content: "Hi", metadata: { ignored: true } },
        { role: "assistant", content: "Hello." },
      ],
      metadata: { traceId: "trace_1" },
    });

    expect(client.chat.completions.create).toHaveBeenCalledWith({
      model: "gpt-test",
      messages: [
        { role: "system", content: "Answer as a concise assistant." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello." },
      ],
      reasoning_effort: "low",
    });
    expect(result).toEqual({
      text: "Hello from OpenAI.",
      metadata: {
        provider: "openai",
        model: "gpt-test",
        responseId: "chatcmpl_test",
        usage: {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        },
      },
    });
  });

  it("flows configurable model and reasoning effort through each request", async () => {
    const client = mockClient({
      model: "gpt-5-mini",
      choices: [{ message: { content: "ok" } }],
    });
    const gateway = new OpenAIConversationModelGateway({
      client,
      model: "gpt-5-mini",
      reasoningEffort: "high",
    });

    await gateway.complete({
      messages: [{ role: "user", content: "Classify this." }],
    });

    expect(client.chat.completions.create).toHaveBeenCalledWith({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "Classify this." }],
      reasoning_effort: "high",
    });
  });

  it("throws when the provider response has no text content", async () => {
    const client = mockClient({
      model: "gpt-test",
      choices: [{ message: { content: null } }],
    });
    const gateway = new OpenAIConversationModelGateway({ client, model: "gpt-test" });

    await expect(gateway.complete({ messages: [{ role: "user", content: "Hi" }] }))
      .rejects
      .toThrow("openai_chat_completion_missing_text");
  });
});
