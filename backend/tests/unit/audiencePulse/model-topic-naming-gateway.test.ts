import { describe, expect, it, vi } from "vitest";

import { ModelTopicNamingGateway, type TopicNamingInferenceFactory } from "../../../src/modules/audiencePulse/infra/modelTopicNamingGateway.js";
import { TOPIC_NAMING_RESPONSE_FORMAT } from "../../../src/modules/audiencePulse/services/topicNamingPrompt.js";
import { TopicLabelValidationError } from "../../../src/modules/audiencePulse/domain/topicLabel.js";
import type { ModelInferenceRequest } from "../../../src/shared/infra/llm/modelInferencePipeline.js";

const workspaceId = "11111111-1111-1111-1111-111111111111";

const buildInferenceFactory = (text: string): TopicNamingInferenceFactory & {
  create: ReturnType<typeof vi.fn>;
} => {
  const complete = vi.fn(async (request: ModelInferenceRequest) => {
    const result = { text };
    // Mirrors `ModelInferencePipelineService.complete`: `validateResult` runs
    // against the raw completion and its rejection propagates as a thrown error.
    request.validateResult?.(result);
    return result;
  });
  return {
    create: vi.fn(async () => ({
      metadata: { capability: "chat" as const, provider: "openai" as const, model: "test-model" },
      complete,
      stream: vi.fn(),
    })),
  };
};

describe("ModelTopicNamingGateway", () => {
  it("returns the parsed label from a well-formed completion", async () => {
    const inferenceFactory = buildInferenceFactory(
      JSON.stringify({ title: "Pricing questions", description: "Visitors asking about plan pricing." }),
    );
    const gateway = new ModelTopicNamingGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    const label = await gateway.name({ prototypical: ["how much does it cost"], peripheral: [] });

    expect(label).toEqual({ title: "Pricing questions", description: "Visitors asking about plan pricing." });
  });

  it("passes the naming response format so malformed output is rejected by the provider schema", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ title: "Pricing", description: "d" }));
    const gateway = new ModelTopicNamingGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await gateway.name({ prototypical: ["how much does it cost"], peripheral: [] });

    const inference = await inferenceFactory.create.mock.results[0]!.value;
    expect(inference.complete).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: TOPIC_NAMING_RESPONSE_FORMAT }),
    );
  });

  it("rejects a completion that is not valid JSON", async () => {
    const inferenceFactory = buildInferenceFactory("not json");
    const gateway = new ModelTopicNamingGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await expect(gateway.name({ prototypical: ["how much does it cost"], peripheral: [] }))
      .rejects.toThrow(TopicLabelValidationError);
  });

  it("rejects a completion that does not match the label schema", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ title: "Pricing" }));
    const gateway = new ModelTopicNamingGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await expect(gateway.name({ prototypical: ["how much does it cost"], peripheral: [] })).rejects.toThrow();
  });

  it("attributes the naming call to the workspace for usage accounting", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ title: "Pricing", description: "d" }));
    const gateway = new ModelTopicNamingGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await gateway.name({ prototypical: ["how much does it cost"], peripheral: [] });

    expect(inferenceFactory.create).toHaveBeenCalledWith({
      workspaceContext: { workspaceId },
      modelCallContext: expect.objectContaining({
        workspaceId,
        surface: "audience_pulse_census",
        operation: "topic_naming",
        attemptKey: expect.any(String),
      }),
    });
    const inference = await inferenceFactory.create.mock.results[0]!.value;
    expect(inference.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ workspaceId, surface: "audience_pulse_census", operation: "topic_naming" }),
      }),
    );
  });

  it("builds the fallback prompt with a distinct operation and no exemplar input", async () => {
    const inferenceFactory = buildInferenceFactory(
      JSON.stringify({ title: "General inquiries", description: "A range of visitor questions." }),
    );
    const gateway = new ModelTopicNamingGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    const label = await gateway.nameFallback();

    expect(label).toEqual({ title: "General inquiries", description: "A range of visitor questions." });
    expect(inferenceFactory.create).toHaveBeenCalledWith({
      workspaceContext: { workspaceId },
      modelCallContext: expect.objectContaining({ operation: "topic_naming_fallback" }),
    });
  });

  it("emits a naming-issued telemetry event with no label content", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ title: "Pricing", description: "d" }));
    const emit = vi.fn().mockResolvedValue(undefined);
    const gateway = new ModelTopicNamingGateway({
      inferenceFactory,
      workspaceContext: { workspaceId },
      telemetryService: { emit },
    });

    await gateway.name({ prototypical: ["how much does it cost"], peripheral: [] });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "audience_pulse.topic_naming_issued",
      correlation: { workspaceId },
      tags: { fallback: "false" },
      metrics: expect.objectContaining({ durationMs: expect.any(Number) }),
    }));
    const payload = JSON.stringify(emit.mock.calls[0]![0]);
    expect(payload).not.toContain("Pricing");
  });

  it("tags the fallback path distinctly in telemetry", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ title: "General", description: "d" }));
    const emit = vi.fn().mockResolvedValue(undefined);
    const gateway = new ModelTopicNamingGateway({
      inferenceFactory,
      workspaceContext: { workspaceId },
      telemetryService: { emit },
    });

    await gateway.nameFallback();

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ tags: { fallback: "true" } }));
  });
});
