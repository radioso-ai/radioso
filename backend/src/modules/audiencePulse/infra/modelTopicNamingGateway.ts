import { randomUUID } from "node:crypto";

import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import type {
  ModelCallIssuedReporter,
  TopicLabel,
  TopicNamingExemplars,
  TopicNamingPort,
} from "../contracts/topicLabel.js";
import { parseTopicLabelModelOutput, TopicLabelValidationError } from "../domain/topicLabel.js";
import {
  TOPIC_NAMING_MAX_OUTPUT_TOKENS,
  TOPIC_NAMING_MAX_TOTAL_TOKENS,
  TOPIC_NAMING_RESPONSE_FORMAT,
  buildTopicFallbackNamingPrompt,
  buildTopicNamingPrompt,
} from "../services/topicNamingPrompt.js";

/**
 * Generic workspace-scoped structured inference seam, narrowed to what naming
 * needs. Mirrors `AudiencePulseInferenceFactory` (`../contracts.ts`) and
 * `FacetExtractionInferenceFactory` (`modules/facets/contracts.ts`): this module
 * declares its own shape instead of importing `ContextualStructuredInferenceFactory`
 * directly, so composition stays free to hand this either the answer tier or the
 * cheap tier without this file knowing which.
 */
export interface TopicNamingInferenceFactory {
  create(input: {
    workspaceContext: { workspaceId: string };
    modelCallContext: ModelCallUsageContext;
  }): Promise<ModelInferencePipeline>;
}

export interface ModelTopicNamingGatewayDependencies {
  inferenceFactory: TopicNamingInferenceFactory;
  workspaceContext: { workspaceId: string };
  telemetryService?: Pick<TelemetryService, "emit">;
}

const parseLabel = (text: string): TopicLabel => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TopicLabelValidationError("Topic naming model response was not valid JSON");
  }
  return parseTopicLabelModelOutput(parsed);
};

/**
 * `TopicNamingPort` (spec 956 "Naming") over the workspace's chat-tier model.
 * Naming reads exemplar facets and writes copy an operator reads directly on the
 * dashboard, so composition constructs this with the answer-tier
 * `ContextualStructuredInferenceFactory` default rather than the cheap `"rewrite"`
 * tier facet extraction and the privacy audit (`ModelTopicLabelPrivacyAuditGateway`)
 * use -- this class only ever calls whatever `inferenceFactory` it is given.
 */
export class ModelTopicNamingGateway implements TopicNamingPort {
  constructor(private readonly deps: ModelTopicNamingGatewayDependencies) {}

  async name(
    exemplars: TopicNamingExemplars,
    signal?: AbortSignal,
    onModelCallIssued?: ModelCallIssuedReporter,
  ): Promise<TopicLabel> {
    return this.call({
      prompt: buildTopicNamingPrompt(exemplars),
      operation: "topic_naming",
      fallback: false,
      signal,
      onModelCallIssued,
    });
  }

  async nameFallback(signal?: AbortSignal, onModelCallIssued?: ModelCallIssuedReporter): Promise<TopicLabel> {
    return this.call({
      prompt: buildTopicFallbackNamingPrompt(),
      operation: "topic_naming_fallback",
      fallback: true,
      signal,
      onModelCallIssued,
    });
  }

  private async call(input: {
    prompt: string;
    operation: string;
    fallback: boolean;
    signal?: AbortSignal;
    onModelCallIssued?: ModelCallIssuedReporter;
  }): Promise<TopicLabel> {
    const { workspaceId } = this.deps.workspaceContext;
    const modelCallContext: ModelCallUsageContext = {
      workspaceId,
      surface: "audience_pulse_census",
      operation: input.operation,
      attemptKey: randomUUID(),
    };
    const startedAtMs = Date.now();
    const inference = await this.deps.inferenceFactory.create({
      workspaceContext: this.deps.workspaceContext,
      modelCallContext,
    });
    input.onModelCallIssued?.();
    const completion = await inference.complete({
      prompt: input.prompt,
      maxInputTokens: TOPIC_NAMING_MAX_TOTAL_TOKENS,
      maxOutputTokens: TOPIC_NAMING_MAX_OUTPUT_TOKENS,
      responseFormat: TOPIC_NAMING_RESPONSE_FORMAT,
      signal: input.signal,
      operation: modelCallContext,
      validateResult(result) {
        parseLabel(result.text);
      },
    });
    const label = parseLabel(completion.text);

    // Counts a naming call as issued (as opposed to reused, which never calls this
    // port at all -- a survived cluster keeps its stored label, `censusService.ts`).
    // No title/description here, ever: this is an identifier-and-count event.
    await this.deps.telemetryService?.emit({
      eventType: "audience_pulse.topic_naming_issued",
      severity: "info",
      correlation: { workspaceId },
      tags: { fallback: String(input.fallback) },
      metrics: { durationMs: Date.now() - startedAtMs },
    }).catch(() => undefined);

    return label;
  }
}
