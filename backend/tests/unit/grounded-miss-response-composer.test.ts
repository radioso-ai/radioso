import { describe, expect, it } from "vitest";

import {
  ModelGroundedMissResponseComposer,
} from "../../src/modules/chat/services/groundedMissResponseComposer.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { TextGenerationClient } from "../../src/shared/infra/llm/providerTypes.js";
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

const pipeline = (client: TextGenerationClient, recorder?: UsageEventRecorder) =>
  new ModelInferencePipelineService(client, recorder);

const usageContext = {
  workspaceId: "workspace-1",
  requestId: "request-1",
  surface: "assistant",
  operation: "answer",
  attemptKey: "grounded_miss",
} as const;

describe("grounded miss response composer", () => {
  it("lets the model compose the full no-context response", async () => {
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(
      composer.composeNoContext({
        query: "What is the capital of France?",
        usageContext,
      }),
    ).resolves.toBe("MODEL_NO_CONTEXT");
  });

  it("requests minimal reasoning effort with budget for the decline so reasoning models don't return empty", async () => {
    let observedRequest: { maxOutputTokens?: number; reasoningEffort?: string; systemPrompt?: string } = {};
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: { capability: "chat", provider: "openai", model: "gpt-5-nano" },
      async complete(request) {
        observedRequest = request;
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await composer.composeNoContext({ query: "What is the capital of France?", usageContext });

    expect(observedRequest.reasoningEffort).toBe("minimal");
    expect(observedRequest.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(256);
    expect(observedRequest.systemPrompt).toContain("do not answer it from general knowledge");
    expect(observedRequest.systemPrompt).toContain("Write in first person as the assistant");
    expect(observedRequest.systemPrompt).toContain("Do not refer to yourself as 'the assistant' or 'this assistant'");
  });

  it("passes assistant scope instructions into no-context generation", async () => {
    let observedPrompt = "";
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete({ prompt }) {
        observedPrompt = prompt;
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await composer.composeNoContext({
      query: "I like potato chips",
      usageContext,
      answerInstructionBlock: "Configured response instructions:\nHelp visitors choose and book Ananda courses.",
    });

    expect(observedPrompt).toContain("Answer Instructions:");
    expect(observedPrompt).toContain('Do not refer to yourself as "the assistant" or "this assistant"');
    expect(observedPrompt).toContain("Help visitors choose and book Ananda courses.");
    expect(observedPrompt).toContain("Redirect back to the Answer Instructions scope");
    expect(observedPrompt).toContain("Do not tell the user only to ask a narrower question");
    expect(observedPrompt).toContain("do not identify, describe, summarize, compare, or explain that entity");
    expect(observedPrompt).toContain("Do not offer to help with unrelated topics from the user query");
    expect(observedPrompt).toContain("Do not mention internal labels");
  });

  it("passes matched steering directives into no-context generation", async () => {
    let observedPrompt = "";
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete({ prompt }) {
        observedPrompt = prompt;
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await composer.composeNoContext({
      query: "Thanks",
      usageContext,
      steering: [
        {
          action: "Prefer short paragraphs and avoid unnecessary structure.",
          source: "directive",
          lifespan: "response",
        },
      ],
    });

    expect(observedPrompt).toContain("The following behavioral directives apply to this turn");
    expect(observedPrompt).toContain("Prefer short paragraphs and avoid unnecessary structure.");
  });

  it("forbids librarian phrasing in the grounded-miss prompt rules", async () => {
    let observedPrompt = "";
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete({ prompt }) {
        observedPrompt = prompt;
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await composer.composeNoContext({ query: "Draft a follow-up", usageContext });

    expect(observedPrompt).toContain("Decline directly in the team's voice");
    expect(observedPrompt).toContain('Do not say "I don\'t have that information,"');
    expect(observedPrompt).toContain("anything that references documents, materials, sources, search, or retrieval");
  });

  it("passes explicit locale guidance into grounded-miss generation", async () => {
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("MODEL_LOCALE_SPECIFIC");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(
      composer.composeNoContext({
        query: "Qual e il prezzo del corso?",
        usageContext,
        userExpectedLocale: "it-IT",
      }),
    ).resolves.toBe("MODEL_LOCALE_SPECIFIC");
  });

  it("records no-context assistant usage when usage context is present", async () => {
    const { recorder, events } = recordingUsageRecorder();
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("MODEL_NO_CONTEXT", {
          inputTokens: 18,
          outputTokens: 4,
          totalTokens: 22,
          providerRequestId: "req-grounded-miss",
          quality: "actual",
        });
      },
      stream() {
        return streamResult([""]);
      },
    }, recorder));

    await composer.composeNoContext({
      query: "What does the pricing page say?",
      usageContext: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        surface: "assistant",
        operation: "answer",
        attemptKey: "grounded_miss",
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
      model: "test-model",
      inputTokens: 18,
      outputTokens: 4,
      totalTokens: 22,
      status: "succeeded",
      usageQuality: "actual",
      providerRequestId: "req-grounded-miss",
    });
    expect(events[0]!.idempotencyKey).toContain("grounded_miss");
  });

  it("records each retried no-context provider attempt separately", async () => {
    const { recorder, events } = recordingUsageRecorder();
    let attempts = 0;
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient provider failure");
        }
        return textResult("MODEL_NO_CONTEXT", {
          inputTokens: 18,
          outputTokens: 4,
          totalTokens: 22,
          quality: "actual",
        });
      },
      stream() {
        return streamResult([""]);
      },
    }, recorder));

    await composer.composeNoContext({
      query: "What does the pricing page say?",
      usageContext: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        surface: "assistant",
        operation: "answer",
        attemptKey: "grounded_miss",
      },
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.status)).toEqual(["failed", "succeeded"]);
    expect(events[0]!.idempotencyKey).toContain("attempt:1");
    expect(events[1]!.idempotencyKey).toContain("attempt:2");
    expect(events[0]!.usageQuality).toBe("estimated");
    expect(events[1]!.usageQuality).toBe("actual");
  });

  it("falls back when the no-context model output is empty", async () => {
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("   ");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const fallback = await composer.composeNoContext({ query: "What is the capital of France?", usageContext });
    expect(fallback).toEqual(expect.any(String));
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).toContain("my current focus");
    expect(fallback).not.toContain("narrower question");
    expect(fallback).not.toContain("this assistant");
    expect(fallback).not.toContain("the assistant");
  });

  it("keeps a scoped no-context response instead of discarding it as boilerplate-worthy", async () => {
    const scopedResponse = [
      "That is outside what I can help with here.",
      "I can help with Ananda Europe, meditation, Kriya Yoga, retreats, satsangs, events, books, videos, news, and the Ananda Assisi retreat center.",
      "If you are exploring spiritual practice, ask about a course, retreat, or upcoming online event.",
      "For example, I can help you find a beginner-friendly meditation option or point you toward the official calendar.",
    ].join(" ");
    expect(scopedResponse.length).toBeGreaterThan(320);

    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult(scopedResponse);
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(
      composer.composeNoContext({ query: "Who is Tesla?", usageContext }),
    ).resolves.toBe(scopedResponse);
  });

  it("falls back when no-context generation returns empty output for another locale", async () => {
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("   ");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const fallback = await composer.composeNoContext({ query: "Qual è la capitale della Francia?", usageContext });
    expect(fallback).toEqual(expect.any(String));
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("falls back without trying to infer locale from ambiguous English tokens", async () => {
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("   ");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const fallback = await composer.composeNoContext({ query: "Was changed in the pricing docs?", usageContext });
    expect(fallback).toEqual(expect.any(String));
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("propagates provider credential errors instead of masking them with fallback copy", async () => {
    const composer = new ModelGroundedMissResponseComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        throw {
          status: 401,
          code: "invalid_api_key",
          error: {
            message: "Incorrect API key provided.",
            code: "invalid_api_key",
          },
        };
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(
      composer.composeNoContext({ query: "What is the capital of France?", usageContext }),
    ).rejects.toMatchObject({
      status: 401,
      code: "invalid_api_key",
    });
  });
});
