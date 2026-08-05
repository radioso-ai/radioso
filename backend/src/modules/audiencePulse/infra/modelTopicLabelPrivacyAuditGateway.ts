import { randomUUID } from "node:crypto";

import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type {
  TopicLabel,
  TopicLabelPrivacyAuditPort,
  TopicLabelPrivacyAuditResult,
} from "../contracts/topicLabel.js";
import { TopicLabelValidationError } from "../domain/topicLabel.js";
import { parseTopicLabelPrivacyAuditOutput } from "../domain/topicLabelPrivacyAudit.js";
import {
  TOPIC_LABEL_AUDIT_MAX_OUTPUT_TOKENS,
  TOPIC_LABEL_AUDIT_MAX_TOTAL_TOKENS,
  TOPIC_LABEL_AUDIT_RESPONSE_FORMAT,
  buildTopicLabelPrivacyAuditPrompt,
} from "../services/topicLabelPrivacyAuditPrompt.js";

/**
 * Generic workspace-scoped structured inference seam, narrowed to what the privacy
 * audit needs. Mirrors `TopicNamingInferenceFactory`; declared separately so the
 * two ports never accidentally share a hardcoded tier.
 */
export interface TopicLabelPrivacyAuditInferenceFactory {
  create(input: {
    workspaceContext: { workspaceId: string };
    modelCallContext: ModelCallUsageContext;
  }): Promise<ModelInferencePipeline>;
}

export interface ModelTopicLabelPrivacyAuditGatewayDependencies {
  inferenceFactory: TopicLabelPrivacyAuditInferenceFactory;
  workspaceContext: { workspaceId: string };
}

const parseAuditResult = (text: string): TopicLabelPrivacyAuditResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TopicLabelValidationError("Topic label privacy audit model response was not valid JSON");
  }
  return parseTopicLabelPrivacyAuditOutput(parsed);
};

/**
 * `TopicLabelPrivacyAuditPort` (spec 956, T021a) over the workspace's cheap-tier
 * model. The audit is a narrow binary judgement over a short, already-generated
 * label -- the same shape of high-volume structured classification the `"rewrite"`
 * tier already serves for facet extraction and query rewriting, not the
 * answer-tier quality naming needs. Composition supplies that tier distinction
 * through which `inferenceFactory` this is constructed with; rejection counting
 * lives in `services/topicLabelPrivacyAudit.ts`'s `resolveAuditedTopicLabel`, the
 * caller of this port, never here.
 */
export class ModelTopicLabelPrivacyAuditGateway implements TopicLabelPrivacyAuditPort {
  constructor(private readonly deps: ModelTopicLabelPrivacyAuditGatewayDependencies) {}

  async review(label: TopicLabel, signal?: AbortSignal): Promise<TopicLabelPrivacyAuditResult> {
    const { workspaceId } = this.deps.workspaceContext;
    const modelCallContext: ModelCallUsageContext = {
      workspaceId,
      surface: "audience_pulse_census",
      operation: "topic_label_privacy_audit",
      attemptKey: randomUUID(),
    };
    const inference = await this.deps.inferenceFactory.create({
      workspaceContext: this.deps.workspaceContext,
      modelCallContext,
    });
    const completion = await inference.complete({
      prompt: buildTopicLabelPrivacyAuditPrompt(label),
      maxInputTokens: TOPIC_LABEL_AUDIT_MAX_TOTAL_TOKENS,
      maxOutputTokens: TOPIC_LABEL_AUDIT_MAX_OUTPUT_TOKENS,
      responseFormat: TOPIC_LABEL_AUDIT_RESPONSE_FORMAT,
      signal,
      operation: modelCallContext,
      validateResult(result) {
        parseAuditResult(result.text);
      },
    });
    return parseAuditResult(completion.text);
  }
}
