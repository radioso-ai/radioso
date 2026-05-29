import { describe, expect, it } from "vitest";

import {
  ModelGroundedMissResponseComposer,
} from "../../src/modules/chat/services/groundedMissResponseComposer.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
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

describe("grounded miss response composer", () => {
  it("lets the model compose the full no-context response", async () => {
    const composer = new ModelGroundedMissResponseComposer({
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
    });

    await expect(
      composer.composeNoContext({
        query: "What is the capital of France?",
      }),
    ).resolves.toBe("MODEL_NO_CONTEXT");
  });

  it("requests minimal reasoning effort with budget for the decline so reasoning models don't return empty", async () => {
    let observedRequest: { maxOutputTokens?: number; reasoningEffort?: string } = {};
    const composer = new ModelGroundedMissResponseComposer({
      metadata: { capability: "chat", provider: "openai", model: "gpt-5-nano" },
      async complete(request) {
        observedRequest = request;
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    });

    await composer.composeNoContext({ query: "What is the capital of France?" });

    expect(observedRequest.reasoningEffort).toBe("minimal");
    expect(observedRequest.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(256);
  });

  it("passes assistant scope instructions into no-context generation", async () => {
    let observedPrompt = "";
    const composer = new ModelGroundedMissResponseComposer({
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
    });

    await composer.composeNoContext({
      query: "I like potato chips",
      answerInstructionBlock: "Configured response instructions:\nHelp visitors choose and book Ananda courses.",
    });

    expect(observedPrompt).toContain("Answer Instructions:");
    expect(observedPrompt).toContain("Help visitors choose and book Ananda courses.");
    expect(observedPrompt).toContain("Redirect back to the Answer Instructions scope");
    expect(observedPrompt).toContain("Do not offer to help with unrelated topics from the user query");
    expect(observedPrompt).toContain("Do not mention internal labels");
  });

  it("forbids librarian phrasing in the grounded-miss prompt rules", async () => {
    let observedPrompt = "";
    const composer = new ModelGroundedMissResponseComposer({
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
    });

    await composer.composeNoContext({ query: "Draft a follow-up" });

    expect(observedPrompt).toContain("Decline directly in the team's voice");
    expect(observedPrompt).toContain('Do not say "I don\'t have that information,"');
    expect(observedPrompt).toContain("anything that references documents, materials, sources, search, or retrieval");
  });

  it("passes explicit locale guidance into grounded-miss generation", async () => {
    const composer = new ModelGroundedMissResponseComposer({
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
    });

    await expect(
      composer.composeNoContext({
        query: "Qual e il prezzo del corso?",
        userExpectedLocale: "it-IT",
      }),
    ).resolves.toBe("MODEL_LOCALE_SPECIFIC");
  });

  it("records no-context assistant usage when usage context is present", async () => {
    const { recorder, events } = recordingUsageRecorder();
    const composer = new ModelGroundedMissResponseComposer({
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
    }, recorder);

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
    const composer = new ModelGroundedMissResponseComposer({
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
    }, recorder);

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
    const composer = new ModelGroundedMissResponseComposer({
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
    });

    const fallback = await composer.composeNoContext({ query: "What is the capital of France?" });
    expect(fallback).toEqual(expect.any(String));
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("falls back when no-context generation returns empty output for another locale", async () => {
    const composer = new ModelGroundedMissResponseComposer({
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
    });

    const fallback = await composer.composeNoContext({ query: "Qual è la capitale della Francia?" });
    expect(fallback).toEqual(expect.any(String));
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("falls back without trying to infer locale from ambiguous English tokens", async () => {
    const composer = new ModelGroundedMissResponseComposer({
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
    });

    const fallback = await composer.composeNoContext({ query: "Was changed in the pricing docs?" });
    expect(fallback).toEqual(expect.any(String));
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("propagates provider credential errors instead of masking them with fallback copy", async () => {
    const composer = new ModelGroundedMissResponseComposer({
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
    });

    await expect(
      composer.composeNoContext({ query: "What is the capital of France?" }),
    ).rejects.toMatchObject({
      status: 401,
      code: "invalid_api_key",
    });
  });
});
