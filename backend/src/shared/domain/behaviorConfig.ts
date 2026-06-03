export const LLM_DEFAULTS = {
  textGenerationMaxOutputTokens: 1536,
} as const;

export const DIRECTIVES_BEHAVIOR = {
  // A contextual directive is injected only when the matcher's confidence is at
  // or above this threshold. Composition-owned default; never tuned per phrase.
  contextualMatchConfidenceThreshold: 0.5,
} as const;

export const CHAT_BEHAVIOR = {
  intentRouting: {
    nonRetrievalConfidenceThreshold: 0.85,
  },
  answer: {
    // gpt-5 family reasoning models otherwise default to medium effort and burn
    // thousands of hidden reasoning tokens before any visible text, which
    // dominates answer latency (and, on streamed turns, time-to-first-token).
    // "low" rather than "minimal": minimal was observed declining answerable
    // grounded questions (the model failed to synthesize/cite retrieved context),
    // so grounded synthesis needs a little reasoning headroom. Still far cheaper
    // than the medium default. Ignored by non-reasoning models and non-OpenAI
    // providers.
    reasoningEffort: "low",
  },
  groundedMiss: {
    temperature: 0,
    // Reasoning models (e.g. gpt-5 family) spend output tokens on hidden reasoning
    // before any visible text; the composer requests minimal reasoning effort, but
    // the cap still needs headroom for the reasoning pass plus the short decline,
    // or the call returns empty and we fall back to canned copy.
    noContextMaxOutputTokens: 512,
    maxResponseLength: 800,
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
  queryInterpretation: {
    // Rewrite, intent classification, and trigger analysis are short structured
    // calls that run before retrieval can start. Minimal reasoning effort avoids
    // a multi-second hidden-reasoning pass on gpt-5 models on the critical path.
    reasoningEffort: "minimal",
  },
  candidateMergeSecondaryWeight: 0.25,
  metadataBoostWeight: 0.2,
  // Multi-topic query rewrites can fan out into several retrieval branches. Each
  // branch runs a cheap lexical search, but a distinct semantic branch costs an
  // embedding plus a concurrent pgvector search. Cap how many *distinct* semantic
  // searches a single turn issues; branches beyond the cap contribute lexical-only
  // (their contexts are pooled downstream regardless). Lexical fan-out is unaffected.
  maxSemanticBranches: 2,
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
    // Scoring candidates is a structured-output task, not a deliberation task;
    // minimal reasoning effort keeps the rerank round-trip off the latency budget
    // on gpt-5 models. Ignored by non-reasoning models and non-OpenAI providers.
    reasoningEffort: "minimal",
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
