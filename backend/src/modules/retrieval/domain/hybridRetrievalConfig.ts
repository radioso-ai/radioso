export const HYBRID_RETRIEVAL_DEFAULTS = {
  lexicalTopK: 20,
  mergedCandidateCap: 50,
  minimumUsefulCandidateCount: 3,
  hardFilterConfidenceThreshold: 0.85,
  attributeValueHardFilterConfidenceThreshold: 0.85,
} as const;
