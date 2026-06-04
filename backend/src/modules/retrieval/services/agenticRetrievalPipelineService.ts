import type {
  FinalPromptContext,
  RetrievalExecutionDiagnostics,
  RetrievalSource,
} from "../domain/retrievalPipelineTypes.js";
import { RESPONSE_INTENT } from "../domain/retrievalPipelineTypes.js";
import type { AgenticRetrievalRunner } from "./agenticRetrievalRunner.js";
import type { RegisteredChunk } from "./agenticTools/index.js";
import type { IngestionSettingsReaderPort } from "./candidateRetrievalStage.js";
import type { PromptBuilder } from "./promptBuilder.js";
import type {
  RetrievalPipelineInterpretationResult,
  RetrievalPipelinePort,
  RetrievalPipelineResult,
} from "./retrievalPipelineService.js";
import type { RetrievalPipelineRequest } from "./retrievalPipelineStages.js";

const APPROX_TOKEN_BYTES = 4;
const AGENT_RETRIEVAL_SOURCE: RetrievalSource = "semantic_rewritten";

export interface AgenticRetrievalPipelineServiceDeps {
  readonly deterministic: RetrievalPipelinePort;
  readonly runner: AgenticRetrievalRunner;
  readonly promptBuilder: PromptBuilder;
  readonly systemPrompt: string;
  /**
   * Reads the workspace's ingestion settings to learn the embedding model the
   * corpus was indexed with. Without this, semantic search runs against the
   * default text-embedding-3-small, which gives empty/wrong results for
   * workspaces indexed with Gemini or another embedding model. Reuses the
   * same port the deterministic pipeline uses (see CandidateRetrievalStage).
   */
  readonly ingestionSettingsService?: IngestionSettingsReaderPort;
}

/**
 * Composes the agentic runner with the deterministic pipeline so the chat path
 * can call the same `RetrievalPipelineService` interface regardless of mode.
 *
 * - `interpret` and `runWithoutRetrieval` delegate to the deterministic
 *   instance — intent classification and the non-retrieval response path are
 *   the same in both modes.
 * - `runInterpreted` dispatches: non-retrieval intents fall back to the
 *   deterministic non-retrieval result; retrieval intents run the agent and
 *   assemble a `RetrievalPipelineResult` from its selected chunks using the
 *   existing `PromptBuilder` for synthesis prompt construction.
 *
 * The agent's `finalize.rationale` is surfaced on `summary.agentic.finalRationale`
 * in the returned trace (FR-024). Flowing it into the synthesis prompt as a
 * structured hint is a separate concern owned by the assistant layer and is
 * not part of this slice — the rationale is already accessible to the
 * assistant layer through the trace.
 */
export class AgenticRetrievalPipelineService implements RetrievalPipelinePort {
  constructor(private readonly deps: AgenticRetrievalPipelineServiceDeps) {}

  async run(input: RetrievalPipelineRequest): Promise<RetrievalPipelineResult> {
    const interpretation = await this.deps.deterministic.interpret(input);
    return this.runInterpreted(interpretation);
  }

  async interpret(input: RetrievalPipelineRequest): Promise<RetrievalPipelineInterpretationResult> {
    return this.deps.deterministic.interpret(input);
  }

  async runWithoutRetrieval(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult> {
    return this.deps.deterministic.runWithoutRetrieval(input);
  }

  async runInterpreted(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult> {
    if (input.interpretation.result.responseIntent !== RESPONSE_INTENT.RETRIEVAL) {
      return this.deps.deterministic.runWithoutRetrieval(input);
    }

    const settings = input.context.result.settings;
    const responseBehavior = input.request.responseBehavior;
    const rewrittenQuery = input.interpretation.result.rewrittenQuery;
    const agentQuery = pickAgentQuery(input);

    const ingestionSettings = await this.deps.ingestionSettingsService?.getForWorkspace(
      input.request.workspaceId,
    );
    const runResult = await this.deps.runner.run({
      workspaceId: input.request.workspaceId,
      query: agentQuery,
      systemPrompt: this.deps.systemPrompt,
      sourceFilter: input.request.sourceFilter,
      metadataFilter: input.request.metadataFilter,
      similarityThreshold: settings.similarityThreshold,
      embeddingModel: ingestionSettings?.embeddingModel,
      usageContext: input.request.usageContext,
    });

    const contexts: FinalPromptContext[] = runResult.selectedChunks.map(toFinalPromptContext);
    const promptResult = this.deps.promptBuilder.build({
      query: input.request.query,
      retrievalQuery: agentQuery,
      history: input.request.history,
      contexts,
      settings: {
        responseIdentity: input.request.responseIdentity,
        customInstruction: responseBehavior?.customInstruction ?? settings.customInstruction,
        responseLanguagePolicy: rewrittenQuery.responseLanguagePolicy,
      },
    });

    const responseSettings = {
      citationDisplayEnabled: responseBehavior?.citationDisplayEnabled ?? true,
      suggestedQuestionsEnabled: settings.suggestedQuestionsEnabled,
      suggestedQuestionsCount: settings.suggestedQuestionsCount,
      customInstruction: responseBehavior?.customInstruction ?? settings.customInstruction,
      responseLanguagePolicy: rewrittenQuery.responseLanguagePolicy,
    };

    const { searchStats } = runResult;
    const diagnostics: RetrievalExecutionDiagnostics = {
      execution: input.request.execution,
      rewriteStatus: rewrittenQuery.status,
      // The agent reranks via a tool call rather than a fixed stage. Report
      // `applied` when it invoked rerank, `skipped` when it did not — mirroring
      // how the deterministic pipeline reports rerank usage to dashboards.
      rerankStatus: searchStats.rerankInvoked ? "applied" : "skipped",
      // Agentic search is semantic-driven; report its distinct semantic
      // candidates under rewrittenCandidateCount (the agent always runs against
      // the rewritten/agent-chosen query), lexical under lexicalCandidateCount,
      // and the merged distinct set as the normalized count.
      originalCandidateCount: 0,
      rewrittenCandidateCount: searchStats.semanticCandidateCount,
      lexicalCandidateCount: searchStats.lexicalCandidateCount,
      normalizedCandidateCount: searchStats.mergedCandidateCount,
      finalContextCount: contexts.length,
      responseIntent: input.interpretation.result.responseIntent,
      retrievalSkipped: false,
      intentConfidence: rewrittenQuery.confidence,
      intentFallbackApplied: rewrittenQuery.status === "fallback",
      parsedQuery: input.interpretation.result.originalPreparedQuery,
      candidateFallbackApplied: false,
      fallbackApplied: runResult.terminatedReason !== "completed",
      rewriteEligible: rewrittenQuery.retrievalEligible,
      rewriteRan: rewrittenQuery.status !== "skipped",
      materialDisagreement: false,
      continuityDecision: input.interpretation.result.continuityDecision,
      rewriteProposal: rewrittenQuery.structuredResult,
      responseLanguagePolicy: rewrittenQuery.responseLanguagePolicy,
      rejectionReason: rewrittenQuery.rejectionReason,
      fallbackReason: rewrittenQuery.fallbackReason,
      triggerAnalysis: input.interpretation.result.triggerAnalysis,
    };

    return {
      rewrittenQuery: agentQuery,
      contexts,
      systemPrompt: promptResult.systemPrompt,
      prompt: promptResult.prompt,
      citations: promptResult.citations,
      responseIdentity: input.request.responseIdentity ?? null,
      responseSettings,
      diagnostics,
      trace: runResult.trace,
    };
  }
}

const pickAgentQuery = (input: RetrievalPipelineInterpretationResult): string => {
  const rewritten = input.interpretation.result.rewrittenQuery;
  if (rewritten.retrievalEligible && rewritten.semanticQuery && rewritten.semanticQuery.length > 0) {
    return rewritten.semanticQuery;
  }
  return input.request.query;
};

const toFinalPromptContext = (chunk: RegisteredChunk, index: number): FinalPromptContext => {
  const estimatedTokenCost = Math.max(1, Math.ceil(chunk.fullContent.length / APPROX_TOKEN_BYTES));
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    title: chunk.title,
    content: chunk.fullContent,
    searchText: chunk.searchText,
    similarity: chunk.similarity,
    chunkIndex: chunk.chunkIndex,
    metadata: chunk.metadata,
    retrievalSources: [AGENT_RETRIEVAL_SOURCE],
    retrievalText: chunk.fullContent,
    semanticScore: chunk.similarity,
    lexicalScore: 0,
    relevanceScore: chunk.similarity,
    rerankPosition: index,
    promptPosition: index,
    estimatedTokenCost,
  };
};
