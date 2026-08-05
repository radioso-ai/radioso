import { z } from "zod";

import { TopicLabelValidationError } from "./topicLabel.js";

export { TopicLabelValidationError };

/**
 * The privacy audit's only judgement: does this already-generated label carry
 * identifying detail? `reason` is deliberately not part of the shape -- a free-text
 * explanation is exactly the kind of thing that could restate the detail being
 * flagged, and the service layer that consumes this must be able to log the
 * rejection without ever holding text derived from the label under review.
 */
export const topicLabelPrivacyAuditOutputSchema = z.object({
  flagged: z.boolean(),
}).strict();

export type TopicLabelPrivacyAuditResult = z.infer<typeof topicLabelPrivacyAuditOutputSchema>;

export const parseTopicLabelPrivacyAuditOutput = (value: unknown): TopicLabelPrivacyAuditResult => {
  const result = topicLabelPrivacyAuditOutputSchema.safeParse(value);
  if (!result.success) {
    throw new TopicLabelValidationError("Topic label privacy audit response did not match the approved schema");
  }
  return result.data;
};
