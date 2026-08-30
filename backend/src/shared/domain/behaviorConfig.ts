export const LLM_DEFAULTS = {
  textGenerationMaxInputTokens: 32_000,
  textGenerationMaxOutputTokens: 1536,
} as const;

export const DIRECTIVES_BEHAVIOR = {
  // A contextual directive is injected only when the matcher's confidence is at
  // or above this threshold. Composition-owned default; never tuned per phrase.
  contextualMatchConfidenceThreshold: 0.5,
  // Bounds on how much contextual directive steering renders into the answer
  // prompt. Always directives and their matched dependencies bypass these caps.
  // The contextual caps keep the highest-signal remainder and record every drop
  // in the turn trace. Composition-owned.
  steeringBound: {
    // Cap on contextual directives, ranked by matcher confidence × priority.
    // Lower-ranked matches beyond the cap are dropped, not rendered.
    maxRenderedDirectives: 8,
    // Approximate token ceiling for contextual steering (~4 chars/token, the
    // repo-standard estimate). Contextual directives fill greedily in rank order;
    // those that would overflow are dropped whole, never truncated mid-action.
    renderedTokenBudget: 2_400,
    // Matcher recall degrades when a single call scores a large candidate set.
    // Above this candidate count the runtime emits a debug warning for builders.
    matcherCandidateWarningThreshold: 40,
  },
} as const;

export const CONTEXT_VARIABLES_BEHAVIOR = {
  // Bounds on always-surfaced host variables in the answer prompt. Staged
  // context remains complete for directive matching and routine binding.
  renderBound: {
    // Variables retain resolution order; this cap decides membership only.
    maxRenderedVariables: 12,
    // JSON values are explicitly marked when shortened before line rendering.
    perValueMaxChars: 600,
    // Approximate prompt ceiling using the repo-standard ~4 chars/token estimate.
    sectionTokenBudget: 1_200,
  },
  // Bounds on the visitor-context projection handed to directive matching (the
  // staged matcher call and the fused planner's directive section). Tighter than
  // the answer prompt: a condition is judged from variable names and values, so
  // long values are clamped rather than given matcher prompt space. Field names
  // come from the shared bound type; "rendered" reads as "kept" here.
  matchBound: {
    maxRenderedVariables: 12,
    perValueMaxChars: 300,
    sectionTokenBudget: 600,
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
  // Fused turn planning replaces the four fresh-turn classification calls
  // (routine activation, turn interpretation, response-language detection,
  // directive match) with a single chat-tier LLM call on eligible turns. These
  // bounds are the fast-path eligibility gate: above any of them the turn
  // bypasses planning and runs the existing staged path unchanged. Kept small so
  // a large candidate set (which degrades single-call classification recall) or
  // an oversized prompt never rides the fused path. Composition-owned; never
  // tuned per phrase.
  turnPlanning: {
    // Reasoning effort for the planner call. "low", not "none": a live A/B on
    // the conversation-quality suite showed referential rewrite resolution (an
    // ordinal follow-up resolving to a listed option) collapsing under strict
    // schema-constrained decoding at "none" (≤6/20 resolved) while "low"
    // resolved 20/20 at roughly +400ms per call — still far cheaper than the
    // staged calls this replaces. "minimal" forces an unsupported-value retry
    // on gpt-5.4-nano and can consume the whole planner timeout; "low" is the
    // retry floor the OpenAI provider downgrades unsupported values to, so it
    // is safe across the gpt-5.4 family.
    reasoningEffort: "low",
    // Output ceiling for the plan JSON (route + rewrite framing + rankings +
    // classifications). Generous enough for a multi-branch retrieval rewrite plus
    // several routine/directive verdicts; still a real bound.
    maxOutputTokens: 1_536,
    // Max routine candidates the planner may rank in one call. Above this the
    // turn bypasses to staged ranked activation (which has its own prefilter).
    maxRoutineCandidates: 8,
    // Max contextual-directive candidates the planner may classify in one call.
    // Mirrors the directive matcher's large-candidate warning threshold so the
    // fused call never scores a set the staged matcher itself would warn about.
    maxDirectiveCandidates: 40,
    // Estimated planner prompt token budget. Above this the turn bypasses to the
    // staged path rather than risk an over-long fused prompt degrading quality.
    maxEstimatedPromptTokens: 6_000,
    // Wall-clock timeout for the planner call. The fused structured response is
    // larger than a staged classifier response; allow its observed slow tail to
    // finish instead of multiplying calls through the staged fallback.
    timeoutMs: 12_000,
    // History tail (most-recent messages) included in the planner prompt, matching
    // the retrieval rewrite context window so routing parity carries over.
    historyTailMessages: 10,
  },
  // Rolling per-conversation summary (#866). Regenerated off the critical path
  // after a turn completes and injected alongside the fixed recent-message window
  // so multi-turn conversations retain context beyond that window. All bounds are
  // composition-owned; none encode product vocabulary.
  conversationSummary: {
    // Below this total message count the raw window already carries the whole
    // conversation, so regeneration is skipped (no row, no LLM call).
    minMessages: 10,
    // Once a summary exists, regenerate only after this many new messages — the
    // uncovered tail rides in the recent-message window anyway. Must stay below
    // rewriteConversationContextMaxMessages or a coverage gap opens between the
    // summary watermark and the window.
    refreshEveryMessages: 6,
    // Newest messages fed into a regeneration; older turns are represented by the
    // previous summary that seeds the call.
    maxSourceMessages: 40,
    // First summary for pre-existing long conversations is allowed to backfill more
    // than one source window, but still has a hard cap so one post-deploy turn cannot
    // fan out into unbounded sequential model calls.
    maxInitialBackfillMessages: 160,
    // Per-message excerpt clamp for the regeneration input (keeps a long single
    // message from dominating the prompt budget).
    maxSourceMessageChars: 500,
    // Hard clamp applied to the generated summary before it is persisted or
    // injected, so the summary can never grow the prompt without bound.
    maxSummaryChars: 1_500,
    // Hard clamp applied to the generated conversation title (issue #1114) before
    // it is persisted to `conversations.title`. The prompt asks for ~8 words; this
    // just bounds a runaway model response, so it stays generous relative to that.
    maxTitleChars: 80,
    // Generous TTL, refreshed on every write; an abandoned conversation's summary
    // is eventually reclaimed and a revived conversation starts fresh.
    ttlDays: 30,
    // Cheap rewrite-tier reasoning effort; this is a background summarization pass,
    // never on the answer latency budget. Ignored by non-reasoning providers.
    reasoningEffort: "minimal",
    // Output ceiling covering minimal hidden reasoning plus the bounded summary.
    maxOutputTokens: 1_024,
    // Early title (issue #1129): a title-only call made once per conversation
    // lifetime, before the conversation is long enough for a real summary — most
    // conversations (3-7 messages) never reach minMessages, so without this the
    // title feature is invisible for typical traffic. A title-only response needs
    // far fewer output tokens than the combined summary+title call.
    maxEarlyTitleOutputTokens: 256,
    // Hard cap on early-title attempts per conversation, regardless of outcome
    // (blank response or thrown error both count). Bounds worst-case LLM spend for
    // a conversation whose early title keeps coming back blank; retried on a later
    // turn commit only while the conversation is still title-less and below
    // minMessages (see ConversationSummaryService).
    maxEarlyTitleAttempts: 2,
  },
  // Perceived-performance budget — "don't keep the user waiting" made checkable.
  // Not model tuning: these are UX guarantees the existing turn telemetry is
  // measured AGAINST. firstTokenTargetMs turns the
  // chat_stream_first_answer_chunk_latency_ms histogram from an un-anchored
  // observation into an SLO. Composition-owned; never tuned per phrase.
  perceivedPerformance: {
    // Target time from stream open to the first answer chunk (time-to-first-
    // token). A budget the histogram is compared to, NOT a hard cap on the model:
    // a turn slower than this increments chat_stream_ttft_budget_exceeded_total
    // (labeled by route) for SLO/alerting, but is never failed or truncated.
    firstTokenTargetMs: 2_500,
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
