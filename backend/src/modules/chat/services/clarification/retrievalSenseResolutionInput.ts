import type { PendingClarificationResolution } from "./pendingClarificationResolver.js";

export interface RetrievalSenseResolutionRequestInput {
  query: string;
  documentScope?: string[];
}

export const retrievalInputForResolvedSense = <TInput extends RetrievalSenseResolutionRequestInput>(
  input: TInput,
  resolution: PendingClarificationResolution | undefined,
): TInput => {
  if (resolution?.kind !== "retrieval_sense") {
    return input;
  }
  return {
    ...input,
    query: resolution.originalQuery ?? input.query,
    documentScope: resolution.documentScope,
  };
};
