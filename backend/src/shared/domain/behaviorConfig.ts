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
    // Reasoning effort for the planner call. #907 measured referential rewrite
    // resolution (an ordinal follow-up resolving to a listed option) collapsing
    // under strict schema-constrained decoding at "none" (≤6/20 resolved) and
    // moved the floor to "low" (20/20, +400ms/call) to compensate. A 2026-09-17
    // A/B (backend/scripts/plannerSchemaAb.ts) found the actual cause was the
    // response schema's field order, not reasoning effort: the schema emitted
    // the resolved query fields (rewrittenQuery/semanticQuery/lexicalQuery)
    // before the derivation fields (turnKind/proposedActiveSubject) that say
    // what the turn refers to, so the model had to commit an answer before
    // writing down the reference it was resolving. Reordering those derivation
    // fields first and adding a leading `resolutionNote` scratch field for the
    // model to resolve the reference into a short clause before the query
    // fields resolves 110/110 cases at "none" — matching "low"'s 110/110 — at
    // p50 1636ms vs 1745ms and 160 vs 203 output tokens (visible scratch tokens
    // replace hidden reasoning tokens). "none" is therefore the correct floor
    // again. "minimal" is still unsupported on gpt-5.4-nano and forces a retry
    // that can consume the whole planner timeout. On the pre-5.4 family the
    // provider maps "none" to "minimal" (knownModels.ts); gpt-5-nano scored
    // 101/110 there vs 109/110 at "low", but the pre-5.4 family costs 3.3-3.8s p50
    // for the planner either way ("none" 3.3s, "low" 3.8s) — a per-family floor of
    // "low" would buy +8/110 accuracy without meaningfully changing the family's
    // already-slow latency. Deliberately not applied: the 5.4 family is the
    // supported tier.
    reasoningEffort: "none",
    // Output ceiling for the plan JSON (route + rewrite framing + rankings +
    // classifications + quick reply). Generous enough for a multi-branch retrieval
    // rewrite plus several routine/directive verdicts; still a real bound. A direct
    // plan at every candidate bound with a quick reply at its length limit is about
    // 4,000 characters, at most ~1,320 tokens even at a pessimistic three characters
    // a token (tests/unit/turn-plan-service.test.ts); a direct plan with no
    // candidates and a two-sentence reply is ~70. The quick reply needed no raise.
    maxOutputTokens: 1_536,
    // Longest quick reply (in characters, after trimming) the planner may write for
    // a turn of pure conversational mechanics. Two short sentences fit well inside;
    // anything longer is not mechanics, so the reply is discarded and the turn's
    // answer is composed as usual.
    maxQuickReplyCharacters: 320,
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
  // SSE presenter behavior once a client disconnects mid-turn (#885). The
  // presenter keeps pumping the turn to completion and persisting it (so a
  // visitor who closes the tab still finds the answer in history) but stops
  // writing to the closed response.
  streaming: {
    // If the turn has not settled this many ms after disconnect, the presenter
    // aborts the turn's AbortSignal (stopping provider generation) and releases
    // the HTTP request rather than waiting indefinitely on a stage that may
    // never settle. Composition-owned; never tuned per phrase.
    disconnectAbortCeilingMs: 120_000,
  },
} as const;

export const RETRIEVAL_BEHAVIOR = {
  defaultSimilarityThreshold: 0.2,
  promptContextTokenBudget: 4800,
  finalContextTopK: 12,
  promptContextMaxCharsPerContext: 900,
  // Caps how many of the final prompt contexts may come from the same document, so one
  // long document cannot crowd out every other source in the answer.
  promptContextMaxPerDocument: 2,
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
  temporal: {
    // The longest date range a question may request: a whole leap year. A longer range
    // is dropped, and the turn falls back to its upcoming-from-today handling.
    requestedDateRangeMaxDays: 366,
    // Passages an answer may hold when it lists the events in a requested date range,
    // in place of `finalContextTopK`, so a busy week reaches the answer. At most
    // `promptContextMaxCharsPerContext` characters each, 20 passages stay inside
    // `promptContextTokenBudget`.
    dateRangeListingContextTopK: 20,
    // Passages a requested-range lookup fetches, most similar to the question first. A busy
    // week runs to about 30 dated passages in one language, and a corpus with a twin per
    // language doubles that; similarity puts the question's own language first, so 40
    // holds a busy week in that language with room to spare. The answer still keeps only
    // the top `dateRangeListingContextTopK` of them.
    dateRangeLookupDepth: 40,
  },
  hybrid: {
    lexicalTopK: 20,
    // Absolute ts_rank_cd evidence floor; query-relative lexicalScore cannot satisfy quality gates.
    // This answers "is there lexical evidence at all?" and is deliberately scale-dependent.
    lexicalMinimumUsefulRankScore: 0.05,
    // Fusion ranks candidates against each other, so its gate must be query-relative:
    // lexicalScore is ts_rank_cd / maxRank within one lexical query, so the top hit is
    // always 1.0 regardless of the query's absolute ts_rank_cd scale. A rare-term query
    // can score every real match below the absolute floor above; gating fusion on that
    // floor makes the only on-topic documents unrankable.
    lexicalFusionMinimumRelativeScore: 0.2,
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

export const VOICE_BEHAVIOR = {
  // A caller hears silence as a dropped line within about a second, but a
  // bridge line in front of a quick reply is worse than a short pause. So the
  // bridge follows the turn's phase, as the chat stream reports it: it fires at
  // once when the turn starts searching (retrieval always has seconds of work
  // ahead); bridgeAfterComposingIdleMs after the turn starts composing with
  // nothing spoken (a quick reply's first sentence lands well inside that); and
  // bridgeAfterMs into a turn that has neither searched nor composed, which
  // only a stalled planner reaches: a knowledge turn bridges on searching as
  // soon as the planner returns. A planner quick reply is the whole turn, and
  // in a headset session (2026-10-14) it took 1.35 to 1.97 s on gpt-5.4-mini
  // (p90 about 2 s), so at 1.8 s a greeting heard the long bridge line before
  // "Hello!"; 2.5 s clears it. Latency is a property of the runtime, not of
  // an agent, so these are composition-owned rather than operator settings.
  bridgeAfterComposingIdleMs: 400,
  bridgeAfterMs: 2_500,
  // When no speech has come this long into a voice turn the agent owns, the
  // channel speaks the agent's authored fallback line and ends the turn; the
  // reply still finishes and is stored. Long enough for a slow grounded answer,
  // short enough that a caller is not left waiting on a line that sounds dead.
  // Measured in local headset sessions (2026-10-14): at 8 s the limit cut off
  // about one grounded turn in fifteen on model latency spikes. The bridge has
  // spoken by then and the ElevenLabs keep-alive holds the stream open through
  // the silence, so 10 s costs the caller nothing but a longer pause.
  // Composition-owned for the same reason as bridgeAfterMs.
  turnLimitMs: 10_000,
  // A voice runtime that loses a reply (it hung up on the stream, or a newer
  // request overtook it) can re-send the same utterance seconds later. Within
  // this window the channel speaks the stored answer again instead of running
  // and storing a second turn; past it, an identical utterance is a new question.
  replayWindowMs: 30_000,
  // A turn asks an ElevenLabs runtime to switch the call's language only while nothing has been
  // spoken on its request and only this long into the turn: the planner names the language in
  // about 1 to 2 s, and past this a caller waiting in silence is better answered in the voice the
  // call has than held back for a switch. On a turn that may switch, no bridge line plays until
  // the language is known or this passes, the 2.5 s stall bridge included, so a slow planner costs
  // up to this much silence before the bridge (the keep-alive holds the stream). The dialect's
  // whitespace keep-alive before the switch is safe (probe, 2026-10-18).
  languageSwitchDecisionMs: 4_000,
  // A switch's follow-up that lands on an instance holding no switched turn finds the answer by
  // reading the conversation, as often as this until the turn limit, so the caller hears the
  // answer the other instance stores rather than silence.
  switchFollowUpPollMs: 250,
  // A turn claims the teammate replies it speaks until it settles, which is at most the turn limit
  // plus the note timeout after it starts on a turn the agent owns, and a moment on one a person
  // owns. A claim older than this belongs to a turn that never settled (its process stopped, or
  // its settling write was lost), so the replies count as pending again and a later turn speaks
  // them; no live turn holds a claim this long.
  operatorReplyClaimExpiryMs: 60_000,
  // ElevenLabs documents that a signed URL opens sessions for 15 minutes after it is issued. The
  // ElevenLabs session starter reports a start's expiresAt from it.
  elevenLabsSignedUrlValidityMs: 15 * 60_000,
  // A session Radioso starts for a page records the visitor who asked for it, so the session's
  // first turn joins that visitor. The URL's validity bounds when the page may open the session,
  // not when its first turn arrives: a session opened near the end of the window, whose caller
  // listens to a greeting and thinks before speaking, has its first turn later still. A record that
  // expired first would let that call join no visitor, silently, so it outlives the URL by a wide
  // margin. An expired record only ever costs that correlation.
  sessionStartTtlMs: 60 * 60_000,
} as const;

export const DOCUMENT_BEHAVIOR = {
  searchEvidenceMaxChars: 180,
} as const;
