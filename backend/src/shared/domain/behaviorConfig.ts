export const LLM_DEFAULTS = {
  textGenerationMaxInputTokens: 32_000,
  textGenerationMaxOutputTokens: 1536,
} as const;

export const DIRECTIVES_BEHAVIOR = {
  // A contextual directive is injected only when the matcher's confidence is at
  // or above this threshold. Composition-owned default; never tuned per phrase.
  contextualMatchConfidenceThreshold: 0.5,
  // Bounds on how much matched directive steering renders into the answer
  // prompt. Unbounded concatenation dilutes compliance and bloats the prompt as
  // the standing set grows; these caps keep the highest-signal directives and
  // record the rest in the turn trace (no silent drops). Composition-owned.
  steeringBound: {
    // Cap on rendered directives, ranked by matcher confidence × priority.
    // Lower-ranked matches beyond the cap are dropped, not rendered.
    maxRenderedDirectives: 8,
    // Approximate token ceiling for the rendered steering block (~4 chars/token,
    // the repo-standard estimate). Directives fill greedily in rank order; those
    // that would overflow are dropped whole, never truncated mid-action.
    renderedTokenBudget: 1_200,
    // Matcher recall degrades when a single call scores a large candidate set.
    // Above this candidate count the runtime emits a debug warning for builders.
    matcherCandidateWarningThreshold: 40,
  },
} as const;

export const CHAT_BEHAVIOR = {
  intentRouting: {
    reasoningEffort: "minimal",
    maxOutputTokens: 512,
  },
  answer: {
    // gpt-5 family reasoning models otherwise default to medium effort and burn
    // thousands of hidden reasoning tokens before any visible text, which
    // dominates answer latency (and, on streamed turns, time-to-first-token).
    // "none" skips the hidden reasoning pass entirely: on the default chat model
    // (gpt-5.4-mini) it roughly halves time-to-first-token vs "low" while still
    // grounding, citing, and inline-linking retrieved context reliably in testing.
    // (Note "minimal" is NOT a valid value for the gpt-5.4 family — it 400s with
    // unsupported_value; "none" is the correct floor. Supported: none/low/medium/
    // high/xhigh.) Ignored by non-reasoning models and non-OpenAI providers.
    reasoningEffort: "none",
    // Dedicated chat-answer ceiling — deliberately NOT the generic 1536 default.
    // On gpt-5-family reasoning models this maps to max_completion_tokens, the
    // TOTAL budget covering hidden reasoning + visible text. At "low" effort the
    // reasoning pass can consume a meaningful share, so 1536 truncated long
    // answers (or returned empty text, tripping BlankChatAnswerError). 4096
    // leaves ample room for low-effort hidden reasoning plus a full multi-
    // paragraph grounded answer while still being a real, bounded ceiling
    // (~3k visible tokens after reasoning headroom). Ignored by non-reasoning
    // models and non-OpenAI providers.
    maxOutputTokens: 4_096,
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
  // A streamed grounded candidate stays private until it contains a complete,
  // in-range sourced assertion. This safety cap bounds that private prefix in
  // Unicode code points; reaching it without an assertion abandons the candidate.
  groundingStreamGateMaxRetainedCodePoints: 4_096,
  queryInterpretation: {
    // Rewrite, intent classification, and trigger analysis are short structured
    // calls that run before retrieval can start. Minimal reasoning effort avoids
    // a multi-second hidden-reasoning pass on gpt-5 models on the critical path.
    reasoningEffort: "minimal",
  },
  // Source ranks, not semantic/lexical score magnitudes, drive hybrid fusion.
  candidateFusionRrfK: 60,
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
    // Absolute ts_rank_cd evidence floor; query-relative lexicalScore cannot satisfy quality gates.
    lexicalMinimumUsefulRankScore: 0.05,
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
