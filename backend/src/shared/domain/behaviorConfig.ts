export const LLM_DEFAULTS = {
  textGenerationMaxOutputTokens: 1536,
} as const;

export const CHAT_BEHAVIOR = {
  intentRouting: {
    nonRetrievalConfidenceThreshold: 0.85,
  },
  unsupportedNotice: {
    temperature: 0,
    maxOutputTokens: 80,
    maxResponseLength: 240,
  },
  groundedMiss: {
    temperature: 0,
    unsupportedWithContextMaxOutputTokens: 120,
    noContextMaxOutputTokens: 80,
    maxTitleLength: 120,
    maxContextLength: 180,
    maxContexts: 3,
    maxResponseLength: 320,
  },
  carryForward: {
    maxLiterals: 6,
    maxLiteralLength: 120,
  },
} as const;

export const RETRIEVAL_BEHAVIOR = {
  defaultSimilarityThreshold: 0.2,
  promptContextTokenBudget: 4800,
  finalContextTopK: 12,
  promptContextMaxCharsPerContext: 900,
  promptContextMinUsefulChars: 24,
  rewriteConversationContextMaxMessages: 10,
  promptHistoryMaxMessages: 4,
  candidateMergeSecondaryWeight: 0.25,
  metadataBoostWeight: 0.2,
  hybrid: {
    lexicalTopK: 20,
    mergedCandidateCap: 50,
    minimumUsefulCandidateCount: 3,
    hardFilterConfidenceThreshold: 0.85,
    attributeValueHardFilterConfidenceThreshold: 0.85,
    triggerMatchEnactmentThreshold: 0.85,
  },
  rerank: {
    temperature: 0.2,
    modelMaxCompletionTokens: 100,
    openAiMinOutputTokens: 200,
    openAiMaxOutputTokens: 1200,
    openAiOutputTokensPerCandidate: 24,
    candidateLimit: 50,
    maxBatchSize: 20,
    maxRetrievalTextChars: 220,
  },
  chunking: {
    fixedWindowChunkSizeDefault: 800,
    fixedWindowChunkOverlapDefault: 120,
    fixedWindowChunkSizeMin: 100,
    fixedWindowChunkSizeMax: 4_000,
    fixedWindowChunkOverlapMin: 0,
    fixedWindowChunkOverlapMax: 2_000,
    structuredMinChunkSizeDefault: 24,
    structuredMaxChunkSizeDefault: 220,
    structuredMinChunkSizeMin: 1,
    structuredMinChunkSizeMax: 1_000,
    structuredMaxChunkSizeMin: 1,
    structuredMaxChunkSizeMax: 2_000,
  },
} as const;

export const DOCUMENT_BEHAVIOR = {
  searchEvidenceMaxChars: 180,
} as const;

export const EVAL_BEHAVIOR = {
  maxContextMessages: 12,
  maxMessageLength: 2_000,
  maxQueryLength: 2_000,
  importConversationMessageLimit: 200,
  datasetNameMaxLength: 120,
  datasetDescriptionMaxLength: 500,
  caseTitleMaxLength: 120,
} as const;
