import type { JsonSchemaResponseFormat } from "../../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { TopicLabel } from "../domain/topicLabel.js";
import { serializeUntrustedInput } from "./untrustedJson.js";

/**
 * A title and description are a few hundred characters at most, so this budget is
 * far smaller than the naming call's -- there is no exemplar text to bound here.
 */
export const TOPIC_LABEL_AUDIT_MAX_TOTAL_TOKENS = 1_500;
export const TOPIC_LABEL_AUDIT_MAX_OUTPUT_TOKENS = 50;

export const TOPIC_LABEL_AUDIT_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "audience_pulse_topic_label_audit",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["flagged"],
    properties: {
      flagged: { type: "boolean" },
    },
  },
};

/**
 * Builds the privacy audit prompt for one already-generated topic label.
 *
 * This is a distinct failure surface from facet extraction: the facet prompt guards
 * content drawn from a single visitor question; this guards a label synthesized from
 * a sample of facets across a cluster, which can recombine detail that no single
 * source facet carried on its own.
 */
export const buildTopicLabelPrivacyAuditPrompt = (label: TopicLabel): string => {
  const template = loadPromptTemplate("audience-pulse-topic-audit.md");
  return `${template}\n\n<topic-label-input>\n${serializeUntrustedInput(label)}\n</topic-label-input>`;
};
