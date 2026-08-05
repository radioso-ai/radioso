import type { JsonSchemaResponseFormat } from "../../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { TopicNamingExemplars } from "../contracts/topicLabel.js";
import { TOPIC_LABEL_TEXT_LIMITS } from "../domain/topicLabel.js";
import { serializeUntrustedInput } from "./untrustedJson.js";

/**
 * Design decision (spec 956, "Naming"): the retired `audience-pulse.md` call did
 * three things in one round trip -- grouped evidence into themes, named each theme,
 * and wrote the summary/recommendations/caveats narrative over the whole sample.
 * Grouping is now arithmetic (clustering + identity matching), which is what this
 * file replaces: one call per cluster, naming only, using the exemplars a clustering
 * step already selected.
 *
 * The summary/recommendations/caveats narrative stays a single call, separate from
 * this one, that runs once per analysis (`services/audiencePulseService.ts`) over the
 * census's already-named topics and their real (SQL-computed) membership -- not over
 * raw evidence it would have to group itself. It sees the richest topics at once
 * (comparisons and recommendations that span topics need more than one topic in
 * view), summarized with the rest in aggregate rather than shown individually
 * (`AUDIENCE_PULSE_SUMMARY_MAX_TOPICS` in `./prompt.ts`), and a recommendation's
 * supporting quotes remain legitimate model work: picking illustrative evidence from
 * a topic's known membership is not the same act as deciding that membership.
 */

/**
 * Total input + output budget for the naming call. Exemplars are a handful of short
 * facets, not a population sample, so this call costs a small fraction of the retired
 * "group and name 80 questions" call it replaces (`AUDIENCE_PULSE_MAX_TOTAL_TOKENS`).
 */
export const TOPIC_NAMING_MAX_TOTAL_TOKENS = 4_000;
export const TOPIC_NAMING_MAX_OUTPUT_TOKENS = 500;

/**
 * Defensive per-exemplar and per-group caps. A stored facet is already short (the
 * facets module bounds it independently), but this module cannot depend on that
 * module's internal constants across the module boundary, so it carries its own
 * bound rather than trusting the caller for a value that feeds a token budget.
 */
export const TOPIC_NAMING_EXEMPLAR_MAX_CHARACTERS = 200;
export const TOPIC_NAMING_MAX_PROTOTYPICAL_EXEMPLARS = 6;
export const TOPIC_NAMING_MAX_PERIPHERAL_EXEMPLARS = 4;

/**
 * Retires the `evidenceIds` partition, the eight-theme ceiling, and the "omit
 * evidence that does not fit" escape hatch that shaped the retired sampled report's
 * response. None of those concepts apply once the model names a cluster it is handed
 * instead of grouping raw evidence: `title` and `description` are the entire output.
 */
export const TOPIC_NAMING_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "audience_pulse_topic_label",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "description"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: TOPIC_LABEL_TEXT_LIMITS.title },
      description: { type: "string", minLength: 1, maxLength: TOPIC_LABEL_TEXT_LIMITS.description },
    },
  },
};

const boundExemplarGroup = (texts: readonly string[], limit: number): string[] =>
  texts.slice(0, limit).map((text) => text.slice(0, TOPIC_NAMING_EXEMPLAR_MAX_CHARACTERS));

/**
 * Builds the naming prompt for one cluster. The model receives two labeled groups of
 * already-extracted, already-clustered facet text -- never raw visitor questions --
 * and returns a title and description for the cluster as a whole. It has no channel
 * to report membership through: the caller decides which facets go in, the response
 * schema has no evidence-id field, and nothing downstream reads one from it.
 */
export const buildTopicNamingPrompt = (exemplars: TopicNamingExemplars): string => {
  const template = loadPromptTemplate("audience-pulse-topic-naming.md");
  const payload = {
    prototypical: boundExemplarGroup(exemplars.prototypical, TOPIC_NAMING_MAX_PROTOTYPICAL_EXEMPLARS),
    peripheral: boundExemplarGroup(exemplars.peripheral, TOPIC_NAMING_MAX_PERIPHERAL_EXEMPLARS),
  };
  return `${template}\n\n<topic-naming-input>\n${serializeUntrustedInput(payload)}\n</topic-naming-input>`;
};

/**
 * Builds the fallback naming prompt used when a label fails privacy review twice.
 * It carries no cluster-specific content at all -- not even a redacted exemplar --
 * so whatever caused the rejection has no channel to reappear in the replacement.
 */
export const buildTopicFallbackNamingPrompt = (): string => loadPromptTemplate("audience-pulse-topic-fallback.md");
