import { describe, expect, it, vi } from "vitest";

import { ModelTopicLabelPrivacyAuditGateway, type TopicLabelPrivacyAuditInferenceFactory } from "../../../src/modules/audiencePulse/infra/modelTopicLabelPrivacyAuditGateway.js";
import { TOPIC_LABEL_AUDIT_RESPONSE_FORMAT } from "../../../src/modules/audiencePulse/services/topicLabelPrivacyAuditPrompt.js";
import { TopicLabelValidationError } from "../../../src/modules/audiencePulse/domain/topicLabel.js";
import type {
  ModelInferencePipeline,
  ModelInferenceRequest,
} from "../../../src/shared/infra/llm/modelInferencePipeline.js";

const workspaceId = "22222222-2222-2222-2222-222222222222";
const label = { title: "Pricing questions", description: "Visitors asking about plan pricing." };

const buildInferenceFactory = (text: string): TopicLabelPrivacyAuditInferenceFactory & {
  create: ReturnType<typeof vi.fn>;
} => {
  const complete = vi.fn(async (request: ModelInferenceRequest) => {
    request.onProviderRequestDispatched?.();
    const result = { text };
    request.validateResult?.(result);
    return result;
  });
  return {
    create: vi.fn(async () => ({
      metadata: { capability: "rewrite" as const, provider: "openai" as const, model: "test-model" },
      complete,
      stream: vi.fn(),
    })),
  };
};

describe("ModelTopicLabelPrivacyAuditGateway", () => {
  it("reports a model call when completion dispatch begins", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ flagged: false }));
    const onModelCallIssued = vi.fn();
    const gateway = new ModelTopicLabelPrivacyAuditGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await gateway.review(label, undefined, onModelCallIssued);

    expect(onModelCallIssued).toHaveBeenCalledTimes(1);
  });

  it("does not report a model call when the signal aborts during inference setup", async () => {
    let resolveCreate!: (inference: ModelInferencePipeline) => void;
    const complete = vi.fn(async (request: ModelInferenceRequest) => {
      if (request.signal?.aborted) {
        throw Object.assign(new Error("aborted before provider dispatch"), { name: "AbortError" });
      }
      return { text: JSON.stringify({ flagged: false }) };
    });
    const inferenceFactory: TopicLabelPrivacyAuditInferenceFactory = {
      create: vi.fn(() => new Promise<ModelInferencePipeline>((resolve) => {
        resolveCreate = resolve;
      })),
    };
    const controller = new AbortController();
    const onModelCallIssued = vi.fn();
    const gateway = new ModelTopicLabelPrivacyAuditGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    const review = gateway.review(label, controller.signal, onModelCallIssued);
    const observedError = review.catch((error: unknown) => error);
    controller.abort();
    resolveCreate({
      metadata: { capability: "rewrite", provider: "openai", model: "test-model" },
      complete,
      stream: vi.fn(),
    });

    await expect(observedError).resolves.toMatchObject({ name: "AbortError" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onModelCallIssued).not.toHaveBeenCalled();
  });

  it("does not report a model call when cancellation wins during provider request preparation", async () => {
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const complete = vi.fn(async (request: ModelInferenceRequest) => {
      await preparation;
      if (request.signal?.aborted) {
        throw Object.assign(new Error("aborted during provider request preparation"), { name: "AbortError" });
      }
      request.onProviderRequestDispatched?.();
      return { text: JSON.stringify({ flagged: false }) };
    });
    const inferenceFactory: TopicLabelPrivacyAuditInferenceFactory = {
      create: vi.fn(async () => ({
        metadata: { capability: "rewrite" as const, provider: "openai" as const, model: "test-model" },
        complete,
        stream: vi.fn(),
      })),
    };
    const controller = new AbortController();
    const onModelCallIssued = vi.fn();
    const gateway = new ModelTopicLabelPrivacyAuditGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    const review = gateway.review(label, controller.signal, onModelCallIssued);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    controller.abort();
    finishPreparation();

    await expect(review).rejects.toMatchObject({ name: "AbortError" });
    expect(onModelCallIssued).not.toHaveBeenCalled();
  });

  it("returns the parsed verdict from a well-formed completion", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ flagged: false }));
    const gateway = new ModelTopicLabelPrivacyAuditGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await expect(gateway.review(label)).resolves.toEqual({ flagged: false });
  });

  it("passes the audit response format so malformed output is rejected by the provider schema", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ flagged: true }));
    const gateway = new ModelTopicLabelPrivacyAuditGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await gateway.review(label);

    const inference = await inferenceFactory.create.mock.results[0]!.value;
    expect(inference.complete).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: TOPIC_LABEL_AUDIT_RESPONSE_FORMAT }),
    );
  });

  it("rejects a completion that is not valid JSON", async () => {
    const inferenceFactory = buildInferenceFactory("not json");
    const gateway = new ModelTopicLabelPrivacyAuditGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await expect(gateway.review(label)).rejects.toThrow(TopicLabelValidationError);
  });

  it("rejects a completion that does not match the audit schema", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ flagged: "yes" }));
    const gateway = new ModelTopicLabelPrivacyAuditGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await expect(gateway.review(label)).rejects.toThrow();
  });

  it("attributes the audit call to the workspace for usage accounting", async () => {
    const inferenceFactory = buildInferenceFactory(JSON.stringify({ flagged: false }));
    const gateway = new ModelTopicLabelPrivacyAuditGateway({ inferenceFactory, workspaceContext: { workspaceId } });

    await gateway.review(label);

    expect(inferenceFactory.create).toHaveBeenCalledWith({
      workspaceContext: { workspaceId },
      modelCallContext: expect.objectContaining({
        workspaceId,
        surface: "audience_pulse_census",
        operation: "topic_label_privacy_audit",
        attemptKey: expect.any(String),
      }),
    });
  });
});
