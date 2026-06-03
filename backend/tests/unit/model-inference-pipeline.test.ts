import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/shared/domain/errors.js";
import { LLM_DEFAULTS } from "../../src/shared/domain/behaviorConfig.js";
import { AGENT_STEP_MAX_INPUT_TOKENS } from "../../src/shared/agent-runtime/index.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { TextGenerationClient } from "../../src/shared/infra/llm/providerTypes.js";
import { streamResult, textResult } from "../support/llmStubs.js";

const usageContext = {
  workspaceId: "workspace-1",
  requestId: "request-1",
  surface: "assistant",
  operation: "answer",
  attemptKey: "attempt-1",
} as const;

const estimateOldByteTokens = (text: string): number => Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));

type BudgetErrorDetails = {
  estimatedInputTokens: number;
  maxInputTokens: number;
  maxOutputTokens?: number;
  estimatedTotalTokens?: number;
  surface: string;
  operation: string;
};

const expectAppError = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("Expected AppError");
};

describe("ModelInferencePipelineService", () => {
  it("rejects oversized non-streaming prompts before calling the provider", async () => {
    const complete = vi.fn(async () => textResult("Answer"));
    const client: TextGenerationClient = {
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete,
      stream: vi.fn(() => streamResult(["Answer"])),
    };
    const pipeline = new ModelInferencePipelineService(client);

    await expect(
      pipeline.complete({
        operation: usageContext,
        prompt: "x".repeat(101),
        maxInputTokens: 25,
      }),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "payload_too_large",
    } satisfies Partial<AppError>);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects oversized streaming prompts before calling the provider", () => {
    const stream = vi.fn(() => streamResult(["Answer"]));
    const client: TextGenerationClient = {
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      async complete() {
        return textResult("Answer");
      },
      stream,
    };
    const pipeline = new ModelInferencePipelineService(client);

    expect(() =>
      pipeline.stream({
        operation: usageContext,
        prompt: "x".repeat(101),
        maxInputTokens: 25,
      }),
    ).toThrowError(AppError);
    expect(stream).not.toHaveBeenCalled();
  });

  it("rejects prompts above the default global input budget when no per-call budget is set", async () => {
    const complete = vi.fn(async () => textResult("Answer"));
    const client: TextGenerationClient = {
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete,
      stream: vi.fn(() => streamResult(["Answer"])),
    };
    const pipeline = new ModelInferencePipelineService(client);

    // ~4 bytes/token: exceed the 32k default budget.
    const oversized = "x".repeat((LLM_DEFAULTS.textGenerationMaxInputTokens + 1_000) * 4);
    await expect(
      pipeline.complete({
        operation: usageContext,
        prompt: oversized,
      }),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "payload_too_large",
    } satisfies Partial<AppError>);
    expect(complete).not.toHaveBeenCalled();
  });

  it("accepts an agent-step prompt above the global default when the larger agent-step budget is set", async () => {
    const complete = vi.fn(async () => textResult("Answer"));
    const client: TextGenerationClient = {
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete,
      stream: vi.fn(() => streamResult(["Answer"])),
    };
    const pipeline = new ModelInferencePipelineService(client);

    // Above the 32k global default but within the agent-step budget: a legitimate
    // deep-retrieval turn that previously aborted with payloadTooLarge(413).
    const tokens = LLM_DEFAULTS.textGenerationMaxInputTokens + 2_000;
    expect(tokens).toBeLessThan(AGENT_STEP_MAX_INPUT_TOKENS);
    const prompt = "x".repeat(tokens * 4);

    await expect(
      pipeline.complete({
        operation: usageContext,
        prompt,
        maxInputTokens: AGENT_STEP_MAX_INPUT_TOKENS,
      }),
    ).resolves.toMatchObject({ text: "Answer" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("uses a conservative input-budget estimate for CJK prompts", async () => {
    const complete = vi.fn(async () => textResult("Answer"));
    const client: TextGenerationClient = {
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete,
      stream: vi.fn(() => streamResult(["Answer"])),
    };
    const pipeline = new ModelInferencePipelineService(client);
    const prompt = "界".repeat(80);
    const oldByteEstimate = estimateOldByteTokens(`\n${prompt}`);

    const error = await expectAppError(
      pipeline.complete({
        operation: usageContext,
        prompt,
        maxInputTokens: oldByteEstimate,
      }),
    );

    expect(error).toMatchObject({
      statusCode: 413,
      code: "payload_too_large",
    } satisfies Partial<AppError>);
    expect(complete).not.toHaveBeenCalled();
    const details = error.details as BudgetErrorDetails;
    expect(details.estimatedInputTokens).toBeGreaterThan(oldByteEstimate);
  });

  it("keeps pure-ASCII budget estimates close to byte-based token estimates", async () => {
    const complete = vi.fn(async () => textResult("Answer"));
    const client: TextGenerationClient = {
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete,
      stream: vi.fn(() => streamResult(["Answer"])),
    };
    const pipeline = new ModelInferencePipelineService(client);
    const prompt = "x".repeat(400);
    const oldByteEstimate = estimateOldByteTokens(`\n${prompt}`);

    const error = await expectAppError(
      pipeline.complete({
        operation: usageContext,
        prompt,
        maxInputTokens: oldByteEstimate - 1,
      }),
    );

    expect(error).toMatchObject({
      statusCode: 413,
      code: "payload_too_large",
    } satisfies Partial<AppError>);
    expect(complete).not.toHaveBeenCalled();
    const details = error.details as BudgetErrorDetails;
    expect(details.estimatedInputTokens).toBeLessThanOrEqual(Math.ceil(oldByteEstimate * 1.1));
  });

  it("reserves requested output tokens when enforcing the input budget", async () => {
    const complete = vi.fn(async () => textResult("Answer"));
    const client: TextGenerationClient = {
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete,
      stream: vi.fn(() => streamResult(["Answer"])),
    };
    const pipeline = new ModelInferencePipelineService(client);

    await expect(
      pipeline.complete({
        operation: usageContext,
        prompt: "x".repeat(76),
        maxInputTokens: 25,
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "payload_too_large",
      details: {
        estimatedInputTokens: 20,
        maxInputTokens: 25,
        maxOutputTokens: 10,
        estimatedTotalTokens: 30,
      },
    } satisfies Partial<AppError>);
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps input-only budget behavior when no max output token request is set", async () => {
    const complete = vi.fn(async () => textResult("Answer"));
    const client: TextGenerationClient = {
      metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
      complete,
      stream: vi.fn(() => streamResult(["Answer"])),
    };
    const pipeline = new ModelInferencePipelineService(client);

    await expect(
      pipeline.complete({
        operation: usageContext,
        prompt: "x".repeat(76),
        maxInputTokens: 20,
      }),
    ).resolves.toMatchObject({ text: "Answer" });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
