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

  it("omits reasoning effort unless the model capability is enabled", async () => {
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
    });
  });

  it("includes reasoning effort when the model capability is enabled", async () => {
    const client = mockClient({
      model: "gpt-5-mini",
      choices: [{ message: { content: "ok" } }],
    });
    const gateway = new OpenAIConversationModelGateway({
      client,
      model: "gpt-5-mini",
      reasoningEffort: "high",
      supportsReasoningEffort: true,
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

  it("throws instead of fabricating a tool_call_id for unsupported tool-role messages", async () => {
    const client = mockClient({
      model: "gpt-test",
      choices: [{ message: { content: "ok" } }],
    });
    const gateway = new OpenAIConversationModelGateway({ client, model: "gpt-test" });

    await expect(gateway.complete({
      messages: [{ role: "tool", content: "Tool output without provider id" }],
    }))
      .rejects
      .toThrow(
        "openai_tool_role_unsupported: tool-role messages require a tool_call_id; not yet supported",
      );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("maps a tool-role message when metadata carries the provider tool_call_id", async () => {
    const client = mockClient({
      model: "gpt-test",
      choices: [{ message: { content: "ok" } }],
    });
    const gateway = new OpenAIConversationModelGateway({ client, model: "gpt-test" });

    await gateway.complete({
      messages: [
        {
          role: "tool",
          content: "Tool output with provider id",
          metadata: { toolCallId: "call_123" },
        },
      ],
    });

    expect(client.chat.completions.create).toHaveBeenCalledWith({
      model: "gpt-test",
      messages: [
        {
          role: "tool",
          content: "Tool output with provider id",
          tool_call_id: "call_123",
        },
      ],
    });
  });

  it("surfaces provider refusals when text content is empty", async () => {
    const client = mockClient({
      model: "gpt-test",
      choices: [
        {
          finish_reason: "stop",
          message: { content: null, refusal: "I cannot help with that request." },
        },
      ],
    });
    const gateway = new OpenAIConversationModelGateway({ client, model: "gpt-test" });

    await expect(gateway.complete({ messages: [{ role: "user", content: "Hi" }] }))
      .rejects
      .toThrow("openai_chat_completion_refusal: I cannot help with that request.");
  });

  it("surfaces length truncation when text content is empty", async () => {
    const client = mockClient({
      model: "gpt-test",
      choices: [{ finish_reason: "length", message: { content: "" } }],
    });
    const gateway = new OpenAIConversationModelGateway({ client, model: "gpt-test" });

    await expect(gateway.complete({ messages: [{ role: "user", content: "Hi" }] }))
      .rejects
      .toThrow("openai_chat_completion_truncated: finish_reason=length");
  });

  it("throws a distinct error when the provider returns no choices", async () => {
    const client = mockClient({
      model: "gpt-test",
      choices: [],
    });
    const gateway = new OpenAIConversationModelGateway({ client, model: "gpt-test" });

    await expect(gateway.complete({ messages: [{ role: "user", content: "Hi" }] }))
      .rejects
      .toThrow("openai_chat_completion_missing_choice");
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
