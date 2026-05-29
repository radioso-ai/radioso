import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { IngestionSettingsService, RetrievalSettingsService } from "../../settings/contracts/services.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type { EmbeddingService } from "./embeddingService.js";
import type { PromptBuildResult } from "./promptBuilder.js";
import { CandidatePreparationService } from "./candidatePreparationService.js";
import { ConversationContextService } from "./conversationContextService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import { RerankService } from "./rerankService.js";
import { RetrievalExecutionTelemetryService } from "./retrievalExecutionTelemetryService.js";
import type { RetrievalExecutionDiagnostics } from "../domain/retrievalPipelineTypes.js";
import { resolveRetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import type { VectorSearchPort } from "../domain/vectorSearch.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import { PromptBuilder } from "./promptBuilder.js";
import { CandidateRetrievalStageService } from "./candidateRetrievalStage.js";
import { CandidatePreparationStageService } from "./candidatePreparationStage.js";
import { ContextSelectionStageService } from "./contextSelectionStage.js";
import { PromptAssemblyStageService } from "./promptAssemblyStage.js";
import { QueryInterpretationStageService } from "./queryInterpretationStage.js";
import { RetrievalContextStageService } from "./retrievalContextStage.js";
import { RetrievalDiagnosticsStageService } from "./retrievalDiagnosticsStage.js";
import { RetrievalPipelineActivityTraceBuilder } from "./retrievalPipelineActivityTraceBuilder.js";
import { MetadataRuleScoringService } from "./metadataRuleScoringService.js";
import { selectRetrievalAnswerShape } from "./retrievalShapeResolver.js";
import type {
  QueryInterpretationStageResult,
  CandidatePreparationStage,
  CandidateRetrievalStage,
  ContextSelectionStage,
  PromptAssemblyStage,
  QueryInterpretationStage,
  RetrievalContextStageResult,
  RetrievalContextStage,
  RetrievalPipelineRequest,
  RetrievalDiagnosticsStage,
} from "./retrievalPipelineStages.js";

export interface RetrievalPipelineResult {
  rewrittenQuery: string;
  contexts: import("../domain/retrievalPipelineTypes.js").FinalPromptContext[];
  systemPrompt: string;
  prompt: string;
  citations: PromptBuildResult["citations"];
  responseIdentity: ResponseIdentity | null;
  responseSettings: {
    citationDisplayEnabled: boolean;
    suggestedQuestionsEnabled: boolean;
    suggestedQuestionsCount: number;
    customInstruction?: string;
    responseLanguagePolicy?: import("../domain/retrievalPipelineTypes.js").ResponseLanguagePolicy;
  };
  diagnostics: RetrievalExecutionDiagnostics;
  trace: import("../domain/retrievalPipelineTypes.js").ActivityTrace;
}

interface MeasuredStage<T> {
  result: T;
  startedAt: number;
  durationMs: number;
}

export interface RetrievalPipelineInterpretationResult {
  request: RetrievalPipelineRequest;
  traceStartedAtMs: number;
  context: MeasuredStage<RetrievalContextStageResult>;
  interpretation: MeasuredStage<QueryInterpretationStageResult>;
}

/**
 * The retrieval pipeline surface consumers depend on. Defined as an interface
 * so the deterministic pipeline, the agentic (reasoning) pipeline, and the
 * strategy-selecting executor are interchangeable without `as unknown as`
 * casts. `RetrievalPipelineService` is the deterministic (fixed) implementation.
 */
export interface RetrievalPipelinePort {
  run(input: RetrievalPipelineRequest): Promise<RetrievalPipelineResult>;
  interpret(input: RetrievalPipelineRequest): Promise<RetrievalPipelineInterpretationResult>;
  runInterpreted(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult>;
  runWithoutRetrieval(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult>;
}

export class RetrievalPipelineService implements RetrievalPipelinePort {
  private readonly retrievalContextStage: RetrievalContextStage;
  private readonly queryInterpretationStage: QueryInterpretationStage;
  private readonly candidateRetrievalStage: CandidateRetrievalStage;
  private readonly candidatePreparationStage: CandidatePreparationStage;
  private readonly contextSelectionStage: ContextSelectionStage;
  private readonly promptAssemblyStage: PromptAssemblyStage;
  private readonly retrievalDiagnosticsStage: RetrievalDiagnosticsStage;
  private readonly activityTraceBuilder = new RetrievalPipelineActivityTraceBuilder();

  constructor(
    retrievalSettingsService: RetrievalSettingsService,
    embeddingService: EmbeddingService,
    vectorSearch: VectorSearchPort,
    lexicalSearch: LexicalSearchPort,
    conversationContextService: ConversationContextService,
    queryRewriteService: QueryRewriteService,
    candidatePreparationService: CandidatePreparationService,
    _attributeMatchScoringService: unknown,
    rerankService: RerankService,
    promptContextSelectorService: PromptContextSelectorService,
    promptBuilder: PromptBuilder,
    retrievalExecutionTelemetryService: RetrievalExecutionTelemetryService,
    _semanticQueryConstraintService?: unknown,
    ingestionSettingsService?: IngestionSettingsService,
  ) {
    this.retrievalContextStage = new RetrievalContextStageService(
      retrievalSettingsService,
      conversationContextService,
    );
    this.queryInterpretationStage = new QueryInterpretationStageService(queryRewriteService);
    this.candidateRetrievalStage = new CandidateRetrievalStageService(
      embeddingService,
      vectorSearch,
      lexicalSearch,
      ingestionSettingsService,
    );
    this.candidatePreparationStage = new CandidatePreparationStageService(
      candidatePreparationService,
      new MetadataRuleScoringService(),
    );
    this.contextSelectionStage = new ContextSelectionStageService(rerankService, promptContextSelectorService);
    this.promptAssemblyStage = new PromptAssemblyStageService(promptBuilder);
    this.retrievalDiagnosticsStage = new RetrievalDiagnosticsStageService(retrievalExecutionTelemetryService);
  }

  async run(input: RetrievalPipelineRequest): Promise<RetrievalPipelineResult> {
    const interpretation = await this.interpret(input);
    return this.runInterpreted(interpretation);
  }

  async interpret(input: RetrievalPipelineRequest): Promise<RetrievalPipelineInterpretationResult> {
    const request = this.resolveRequest(input);
    const traceStartedAtMs = Date.now();
    const context = await this.measure(() => this.retrievalContextStage.execute(request));
    const interpretation = await this.measure(() => this.queryInterpretationStage.execute(context.result));

    return {
      request,
      traceStartedAtMs,
      context,
      interpretation,
    };
  }

  async runInterpreted(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult> {
    const shapeSelection = this.shouldSelectRetrievalAnswerShape(input.request)
      ? await this.measure(() => selectRetrievalAnswerShape({
          query: input.request.query,
          rewrittenQuery: input.interpretation.result.rewrittenQuery,
        }))
      : undefined;
    const interpretation = {
      ...input.interpretation,
      result: {
        ...input.interpretation.result,
        request: input.request,
        shapeSelection: shapeSelection?.result,
      },
    };
    const retrieval = await this.measure(() => this.candidateRetrievalStage.execute(interpretation.result));
    const prepared = await this.measure(() => this.candidatePreparationStage.execute(retrieval.result));
    const selection = await this.measure(() => this.contextSelectionStage.execute(prepared.result));
    const prompt = await this.measure(() => this.promptAssemblyStage.execute(selection.result));
    const diagnostics = await this.measure(() => this.retrievalDiagnosticsStage.execute(prompt.result));
    const trace = this.activityTraceBuilder.buildActivityTrace({
      traceStartedAtMs: input.traceStartedAtMs,
      context: input.context,
      interpretation,
      shapeSelection,
      retrieval,
      prepared,
      selection,
      prompt,
      diagnostics,
    });

    return {
      rewrittenQuery: prompt.result.activeQuery,
      contexts: prompt.result.contexts,
      systemPrompt: prompt.result.systemPrompt,
      prompt: prompt.result.prompt,
      citations: prompt.result.citations,
      responseIdentity: input.request.responseIdentity ?? null,
      responseSettings: prompt.result.responseSettings,
      diagnostics: diagnostics.result,
      trace,
    };
  }

  async runWithoutRetrieval(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult> {
    const responseBehavior = input.request.responseBehavior;
    const responseSettings = {
      citationDisplayEnabled: input.context.result.settings.citationDisplayEnabled,
      suggestedQuestionsEnabled: responseBehavior?.suggestedQuestionsEnabled ?? input.context.result.settings.suggestedQuestionsEnabled,
      suggestedQuestionsCount: responseBehavior?.suggestedQuestionsCount ?? input.context.result.settings.suggestedQuestionsCount,
      customInstruction: responseBehavior?.customInstruction ?? input.context.result.settings.customInstruction,
      responseLanguagePolicy: input.interpretation.result.rewrittenQuery.responseLanguagePolicy ?? "match_user_question",
    };
    const diagnostics: RetrievalExecutionDiagnostics = {
      execution: input.request.execution,
      rewriteStatus: input.interpretation.result.rewrittenQuery.status,
      rerankStatus: "skipped",
      originalCandidateCount: 0,
      rewrittenCandidateCount: 0,
      lexicalCandidateCount: 0,
      normalizedCandidateCount: 0,
      finalContextCount: 0,
      responseIntent: input.interpretation.result.responseIntent,
      retrievalSkipped: true,
      intentConfidence: input.interpretation.result.rewrittenQuery.confidence,
      intentFallbackApplied: input.interpretation.result.rewrittenQuery.status === "fallback",
      parsedQuery: input.interpretation.result.originalPreparedQuery,
      candidateFallbackApplied: false,
      fallbackApplied: false,
      rewriteEligible: input.interpretation.result.rewrittenQuery.retrievalEligible,
      rewriteRan: input.interpretation.result.rewrittenQuery.status !== "skipped",
      materialDisagreement: false,
      continuityDecision: input.interpretation.result.continuityDecision,
      rewriteProposal: input.interpretation.result.rewrittenQuery.structuredResult,
      responseLanguagePolicy: input.interpretation.result.rewrittenQuery.responseLanguagePolicy,
      rejectionReason: input.interpretation.result.rewrittenQuery.rejectionReason,
      fallbackReason: input.interpretation.result.rewrittenQuery.fallbackReason,
      triggerAnalysis: {
        status: "skipped_non_retrieval",
        consideredRules: [],
        matchedRuleIds: [],
        unmatchedRuleIds: [],
        matchCount: 0,
        matcherVersion: "non_retrieval",
      },
    };
    const trace = this.activityTraceBuilder.buildNonActivityTrace({
      request: input.request,
      traceStartedAtMs: input.traceStartedAtMs,
      context: input.context,
      interpretation: input.interpretation,
    }, diagnostics);

    return {
      rewrittenQuery: input.request.query,
      contexts: [],
      systemPrompt: "",
      prompt: "",
      citations: [],
      responseIdentity: input.request.responseIdentity ?? null,
      responseSettings,
      diagnostics,
      trace,
    };
  }

  private resolveRequest(input: RetrievalPipelineRequest): RetrievalPipelineRequest {
    return {
      ...input,
      responseIdentity: input.responseIdentity ?? null,
      sourceFilter: resolveRetrievalSourceFilter(input.sourceScope),
      usageContext: input.usageContext ?? {
        workspaceId: input.workspaceId,
        requestId: randomUUID(),
        surface: input.execution?.surface ?? "retrieval",
        attemptKey: input.execution?.path ?? "pipeline",
      },
    };
  }

  private shouldSelectRetrievalAnswerShape(input: RetrievalPipelineRequest): boolean {
    return input.execution?.path === "retrieval_answer" ||
      input.execution?.path === "mcp_grounded_answer" ||
      input.execution?.path === "assistant_retrieval";
  }

  private async measure<T>(runStage: () => Promise<T> | T): Promise<MeasuredStage<T>> {
    const startedAt = Date.now();
    const result = await runStage();
    const finishedAt = Date.now();

    return {
      result,
      startedAt,
      durationMs: finishedAt - startedAt,
    };
  }
}
