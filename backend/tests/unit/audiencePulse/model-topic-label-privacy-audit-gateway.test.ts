import { describe, expect, it, vi } from "vitest";

import { ModelTopicLabelPrivacyAuditGateway, type TopicLabelPrivacyAuditInferenceFactory } from "../../../src/modules/audiencePulse/infra/modelTopicLabelPrivacyAuditGateway.js";
import { TOPIC_LABEL_AUDIT_RESPONSE_FORMAT } from "../../../src/modules/audiencePulse/services/topicLabelPrivacyAuditPrompt.js";
import { TopicLabelValidationError } from "../../../src/modules/audiencePulse/domain/topicLabel.js";
import type { ModelInferenceRequest } from "../../../src/shared/infra/llm/modelInferencePipeline.js";

const workspaceId = "22222222-2222-2222-2222-222222222222";
const label = { title: "Pricing questions", description: "Visitors asking about plan pricing." };

const buildInferenceFactory = (text: string): TopicLabelPrivacyAuditInferenceFactory & {
  create: ReturnType<typeof vi.fn>;
} => {
  const complete = vi.fn(async (request: ModelInferenceRequest) => {
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
