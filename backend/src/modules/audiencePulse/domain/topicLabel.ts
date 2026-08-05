import { z } from "zod";

/**
 * A topic label is produced by exactly two kinds of model calls: naming a cluster
 * from its exemplar facets (`services/topicNamingPrompt.ts`), or -- when a label
 * fails privacy review twice -- a neutral fallback with no cluster-specific input
 * (`buildTopicFallbackNamingPrompt`). Both return this same shape, so downstream code
 * (persistence, the report narrative) treats a topic's name as a name regardless of
 * which call produced it.
 */
export const TOPIC_LABEL_TEXT_LIMITS = {
  title: 120,
  description: 250,
} as const;

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const topicLabelModelOutputSchema = z.object({
  title: boundedText(TOPIC_LABEL_TEXT_LIMITS.title),
  description: boundedText(TOPIC_LABEL_TEXT_LIMITS.description),
}).strict();

export type TopicLabel = z.infer<typeof topicLabelModelOutputSchema>;

export class TopicLabelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicLabelValidationError";
  }
}

/**
 * Parses a naming or fallback call's response. The schema is `.strict()`, so a
 * response that tries to attach anything beyond a title and description --
 * evidence ids, a theme index, a membership list -- fails validation rather than
 * being silently accepted; there is no field for a cluster naming call to express
 * membership through in the first place.
 */
export const parseTopicLabelModelOutput = (value: unknown): TopicLabel => {
  const result = topicLabelModelOutputSchema.safeParse(value);
  if (!result.success) {
    throw new TopicLabelValidationError("Topic label model response did not match the approved schema");
  }
  return result.data;
};
