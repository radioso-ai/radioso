import { describe, expect, it } from "vitest";

import { ModelChatGateway } from "../../src/modules/chat/services/chatService.js";
import type {
  TextGenerationClient,
  TextGenerationRequest,
} from "../../src/shared/infra/llm/providerTypes.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import { streamResult, textResult } from "../support/llmStubs.js";

const recordingUsageRecorder = () => {
  const events: ModelUsageEvent[] = [];
  const recorder: UsageEventRecorder = {
    async recordEmbedding() {},
    async recordModelCall(event) {
      events.push(event);
    },
  };
  return { recorder, events };
};

const usageContext = {
  workspaceId: "workspace-1",
  requestId: "request-1",
  surface: "assistant",
  operation: "answer",
  attemptKey: "attempt-1",
} as const;

describe("ModelChatGateway", () => {
  it("passes system prompts through to non-streaming generation", async () => {
    const requests: TextGenerationRequest[] = [];
    const gateway = new ModelChatGateway(new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai-compatible", model: "test-chat" },
      async complete(input) {
        requests.push(input);
        return textResult("Answer");
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient));

    await gateway.answer({
      query: "Question",
      history: [],
      systemPrompt: "System instructions",
      prompt: "User prompt",
      usageContext,
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
    const gateway = new ModelChatGateway(new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai-compatible", model: "test-chat" },
      async complete() {
        return textResult("Answer");
      },
      stream(input) {
        requests.push(input);
        return streamResult(["A", "B"]);
      },
    } satisfies TextGenerationClient));

    const chunks: string[] = [];
    for await (const chunk of gateway.streamAnswer({
      query: "Question",
      history: [],
      systemPrompt: "System instructions",
      prompt: "User prompt",
      usageContext,
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

  it("records non-streaming assistant usage when usage context is present", async () => {
    const { recorder, events } = recordingUsageRecorder();
    const gateway = new ModelChatGateway(new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      async complete(input) {
        return textResult("Answer", {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
          providerRequestId: "req-1",
          quality: "actual",
        });
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient, recorder));

    await gateway.answer({
      query: "Question",
      history: [],
      systemPrompt: "System instructions",
      prompt: "User prompt",
      usageContext: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        surface: "assistant",
        operation: "answer",
        attemptKey: "non_retrieval",
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: "account-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      surface: "assistant",
      operation: "answer",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      status: "succeeded",
      usageQuality: "actual",
      providerRequestId: "req-1",
    });
    expect(events[0]!.idempotencyKey).toContain("non_retrieval");
  });

  it("records streaming assistant usage after the stream completes", async () => {
    const { recorder, events } = recordingUsageRecorder();
    const gateway = new ModelChatGateway(new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-stream" },
      async complete() {
        return textResult("Answer");
      },
      stream() {
        return streamResult(["A", "B"], {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
          quality: "actual",
        });
      },
    } satisfies TextGenerationClient, recorder));

    const chunks: string[] = [];
    for await (const chunk of gateway.streamAnswer({
      query: "Question",
      history: [],
      prompt: "User prompt",
      usageContext: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        surface: "assistant",
        operation: "answer",
        attemptKey: "stream_grounded",
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["A", "B"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      provider: "openai",
      model: "gpt-stream",
      outputTokens: 2,
      status: "succeeded",
      usageQuality: "actual",
    });
  });

  it("records request-scoped usage without conversation or message lineage", async () => {
    const { recorder, events } = recordingUsageRecorder();
    const gateway = new ModelChatGateway(new ModelInferencePipelineService({
      metadata: { capability: "chat", provider: "openai", model: "gpt-request" },
      async complete() {
        return textResult("Answer", {
          inputTokens: 8,
          outputTokens: 2,
          totalTokens: 10,
          quality: "actual",
        });
      },
      stream() {
        return streamResult([""]);
      },
    } satisfies TextGenerationClient, recorder));

    await gateway.answer({
      query: "Question",
      history: [],
      prompt: "User prompt",
      usageContext: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        requestId: "request-1",
        surface: "retrieval",
        operation: "grounded_answer",
        attemptKey: "answer",
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: "account-1",
      workspaceId: "workspace-1",
      conversationId: null,
      messageId: null,
      surface: "retrieval",
      operation: "grounded_answer",
      provider: "openai",
      model: "gpt-request",
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      usageQuality: "actual",
    });
    expect(events[0]!.idempotencyKey).toContain("request-1");
  });
});
