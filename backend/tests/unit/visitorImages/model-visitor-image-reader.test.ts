import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../src/shared/domain/errors.js";
import type { ModelInferenceRequest } from "../../../src/shared/infra/llm/modelInferencePipeline.js";
import type { TextGenerationResult } from "../../../src/shared/infra/llm/providerTypes.js";
import {
  ModelVisitorImageReader,
  type VisitorImageReadingModel,
} from "../../../src/modules/visitorImages/services/modelVisitorImageReader.js";

const IMAGE = { mediaType: "image/jpeg" as const, base64Data: "/9j/4AAQSkZJRg==" };

const answering = (text: string | (() => Promise<TextGenerationResult>)) => {
  const complete = vi.fn(async (request: ModelInferenceRequest): Promise<TextGenerationResult> => {
    const result = typeof text === "string" ? { text } as TextGenerationResult : await text();
    request.validateResult?.(result);
    return result;
  });
  const model: VisitorImageReadingModel = {
    forAgent: vi.fn(async () => ({ inference: { complete }, defaultLocale: "de" })),
  };
  return { complete, model };
};

const logger = () => ({ info: vi.fn(), warn: vi.fn() });

const readInput = {
  workspaceId: "8d2b8f0e-6a1e-4c1a-9a43-0c1b2b5f9a01",
  agentId: "1f0e0c7c-2b8e-4a55-8e3b-7d8f7f0c8a11",
  imageId: "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12",
  image: IMAGE,
  locale: "it",
  surface: "website_embed",
};

describe("ModelVisitorImageReader", () => {
  it("asks the agent's chat model once, with the photo on the turn, and keeps the description", async () => {
    const { complete, model } = answering(JSON.stringify({ description: "A stone farmhouse with a terracotta roof." }));
    const reader = new ModelVisitorImageReader({ model, logger: logger() });

    const reading = await reader.read(readInput);

    expect(reading).toEqual({ kind: "read", description: "A stone farmhouse with a terracotta roof." });
    expect(model.forAgent).toHaveBeenCalledWith({
      workspaceId: readInput.workspaceId,
      agentId: readInput.agentId,
      modelCallContext: expect.objectContaining({
        workspaceId: readInput.workspaceId,
        agentId: readInput.agentId,
        surface: "website_embed",
        operation: "visitor_image.read",
      }),
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0];
    expect(request.images).toEqual([IMAGE]);
    expect(request.responseFormat).toMatchObject({ type: "json_schema", strict: true });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.prompt).toContain("\"locale\":\"it\"");
  });

  it("writes in the agent's default locale when the visitor's is unknown", async () => {
    const { complete, model } = answering(JSON.stringify({ description: "Ein Fahrrad." }));
    const reader = new ModelVisitorImageReader({ model, logger: logger() });

    await reader.read({ ...readInput, locale: null });

    expect(complete.mock.calls[0][0].prompt).toContain("\"locale\":\"de\"");
  });

  it("bounds a long description", async () => {
    const { model } = answering(JSON.stringify({ description: "x".repeat(5_000) }));
    const reader = new ModelVisitorImageReader({ model, logger: logger() });

    const reading = await reader.read(readInput);

    expect(reading.kind).toBe("read");
    expect(reading.kind === "read" ? reading.description.length : 0).toBeLessThanOrEqual(2_000);
  });

  it("fails open as unread when the model's answer is not the schema", async () => {
    const { model } = answering("Sure! Here is the photo.");
    const log = logger();
    const reader = new ModelVisitorImageReader({ model, logger: log });

    expect(await reader.read(readInput)).toEqual({ kind: "unread", reason: "invalid_result" });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ imageId: readInput.imageId, reason: "invalid_result" }), expect.any(String));
  });

  it("fails open as unread when the model cannot read images", async () => {
    const { model } = answering(async () => {
      throw new AppError(422, "image_input_unsupported", "The configured model cannot read images");
    });

    expect(await new ModelVisitorImageReader({ model, logger: logger() }).read(readInput)).toEqual({ kind: "unread", reason: "model_cannot_read" });
  });

  it("fails open as unread when the call outlives its timeout", async () => {
    const complete = vi.fn((request: ModelInferenceRequest) => new Promise<TextGenerationResult>((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason instanceof Error ? request.signal.reason : new Error("aborted")));
    }));
    const model: VisitorImageReadingModel = { forAgent: async () => ({ inference: { complete }, defaultLocale: "en" }) };

    expect(await new ModelVisitorImageReader({ model, logger: logger(), timeoutMs: 5 }).read(readInput)).toEqual({ kind: "unread", reason: "timeout" });
  });

  it("reads nothing for an agent that is gone", async () => {
    const model: VisitorImageReadingModel = { forAgent: async () => null };

    expect(await new ModelVisitorImageReader({ model, logger: logger() }).read(readInput)).toEqual({ kind: "unread", reason: "agent_not_found" });
  });

  it("never logs the photo or the description", async () => {
    const { model } = answering(JSON.stringify({ description: "A secret-looking label reading \"ABC-123\"." }));
    const log = logger();

    await new ModelVisitorImageReader({ model, logger: log }).read(readInput);

    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).not.toContain(IMAGE.base64Data);
    expect(logged).not.toContain("ABC-123");
  });
});
