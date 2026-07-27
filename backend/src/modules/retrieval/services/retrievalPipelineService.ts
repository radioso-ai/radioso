import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type {
  QueryEmbeddingPort,
} from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { PromptBuildResult } from "./promptBuilder.js";
import { CandidatePreparationService } from "./candidatePreparationService.js";
import { ConversationContextService } from "./conversationContextService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import { RerankService } from "./rerankService.js";
import { RetrievalExecutionTelemetryService } from "./retrievalExecutionTelemetryService.js";
import type { RetrievalExecutionDiagnostics } from "../domain/retrievalPipelineTypes.js";
import { resolveRetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import type { RetrievalDefaultsProvider } from "../domain/retrievalDefaultsProvider.js";
import type { VectorCandidateSearchPort } from "../domain/vectorAdapter.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import type { ChunkCandidateHydratorPort } from "../infra/chunkCandidateHydrator.js";
import type { TemporalCandidateRetrievalPort } from "../domain/temporal/temporalCandidateRetrieval.js";
import { PromptBuilder } from "./promptBuilder.js";
import { CandidateRetrievalStageService } from "./candidateRetrievalStage.js";
import { CandidatePreparationStageService } from "./candidatePreparationStage.js";
import { ContextSelectionStageService } from "./contextSelectionStage.js";
import { PromptAssemblyStageService } from "./promptAssemblyStage.js";
import {
  QueryInterpretationStageService,
  deferTriggerAnalysisForConcurrentPipeline,
} from "./queryInterpretationStage.js";
import { RetrievalContextStageService, type SkillSettingsResolver } from "./retrievalContextStage.js";
import { RetrievalDiagnosticsStageService } from "./retrievalDiagnosticsStage.js";
import { RetrievalPipelineActivityTraceBuilder } from "./retrievalPipelineActivityTraceBuilder.js";
import { MetadataRuleScoringService } from "./metadataRuleScoringService.js";
import { selectRetrievalAnswerShape } from "./retrievalShapeResolver.js";
import {
  RETRIEVAL_TRACE_SPAN_NAMES,
  buildCandidatePreparationTraceAttributes,
  buildCandidateRetrievalTraceAttributes,
  buildContextSelectionTraceAttributes,
  buildPromptAssemblyTraceAttributes,
  buildQueryInterpretationTraceAttributes,
  buildRetrievalContextTraceAttributes,
  buildRetrievalPipelineTraceAttributes,
} from "./retrievalPipelineStages.js";
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
  TraceAttributes,
} from "./retrievalPipelineStages.js";

const traceActiveSpan = <T>(
  name: string,
  attributes: TraceAttributes,
  run: () => Promise<T> | T,
  resultAttributes?: (result: T) => TraceAttributes,
): Promise<T> => traceOperation({ name, attributes, run, resultAttributes });

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
    responseLanguage?: string;
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
    retrievalDefaultsProvider: RetrievalDefaultsProvider,
    queryEmbeddings: QueryEmbeddingPort,
    vectorSearch: VectorCandidateSearchPort,
    lexicalSearch: LexicalSearchPort,
    conversationContextService: ConversationContextService,
    queryRewriteService: QueryRewriteService,
    candidatePreparationService: CandidatePreparationService,
    _attributeMatchScoringService: unknown,
    rerankService: RerankService,
    promptContextSelectorService: PromptContextSelectorService,
    promptBuilder: PromptBuilder,
    retrievalExecutionTelemetryService: RetrievalExecutionTelemetryService,
    _semanticQueryConstraintService: unknown,
    skillSettingsResolver: SkillSettingsResolver | undefined,
    chunkHydrator: ChunkCandidateHydratorPort,
    temporalCandidateRetrieval?: TemporalCandidateRetrievalPort,
  ) {
    this.retrievalContextStage = new RetrievalContextStageService(
      retrievalDefaultsProvider,
      conversationContextService,
      skillSettingsResolver,
    );
    this.queryInterpretationStage = new QueryInterpretationStageService(queryRewriteService);
    this.candidateRetrievalStage = new CandidateRetrievalStageService(
      queryEmbeddings,
      vectorSearch,
      lexicalSearch,
      chunkHydrator,
      temporalCandidateRetrieval,
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
    return traceActiveSpan(RETRIEVAL_TRACE_SPAN_NAMES.pipelineRun, buildRetrievalPipelineTraceAttributes(input), async () => {
      const interpretation = await this.interpret(input);
      return this.runInterpreted(interpretation);
    });
  }

  async interpret(input: RetrievalPipelineRequest): Promise<RetrievalPipelineInterpretationResult> {
    const request = this.resolveRequest(input);
    return traceActiveSpan(RETRIEVAL_TRACE_SPAN_NAMES.pipelineInterpret, buildRetrievalPipelineTraceAttributes(request), async () => {
      const traceStartedAtMs = Date.now();
      const context = await this.measureTraced(
        RETRIEVAL_TRACE_SPAN_NAMES.context,
        buildRetrievalPipelineTraceAttributes(request),
        () => this.retrievalContextStage.execute(request),
        buildRetrievalContextTraceAttributes,
      );
      const interpretation = await this.measureTraced(
        RETRIEVAL_TRACE_SPAN_NAMES.queryInterpretation,
        buildRetrievalContextTraceAttributes(context.result),
        () => this.queryInterpretationStage.execute(deferTriggerAnalysisForConcurrentPipeline(context.result)),
        buildQueryInterpretationTraceAttributes,
      );

      return {
        request,
        traceStartedAtMs,
        context,
        interpretation,
      };
    });
  }

  async runInterpreted(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult> {
    return traceActiveSpan(RETRIEVAL_TRACE_SPAN_NAMES.pipelineRunInterpreted, buildRetrievalPipelineTraceAttributes(input.request), async () => {
      const shapeSelection = this.shouldSelectRetrievalAnswerShape(input.request)
        ? await this.measureTraced(
            RETRIEVAL_TRACE_SPAN_NAMES.answerShapeSelection,
            buildQueryInterpretationTraceAttributes(input.interpretation.result),
            () => selectRetrievalAnswerShape({
              query: input.request.query,
              rewrittenQuery: input.interpretation.result.rewrittenQuery,
            }),
            (result) => ({
              "retrieval.answer_shape.selection_mode": result.selectionMode,
              "retrieval.answer_shape.skill": result.resolvedRun.skillName,
            }),
          )
        : undefined;
      const interpretation = {
        ...input.interpretation,
        result: {
          ...input.interpretation.result,
          request: input.request,
          shapeSelection: shapeSelection?.result,
        },
      };
      const triggerAnalysisPromise = this.queryInterpretationStage.analyzeTriggers
        ? this.measureTraced(
            RETRIEVAL_TRACE_SPAN_NAMES.triggerAnalysis,
            buildQueryInterpretationTraceAttributes(interpretation.result),
            () => this.queryInterpretationStage.analyzeTriggers!(interpretation.result),
            (result) => ({
              "retrieval.trigger.status": result.status,
              "retrieval.trigger.match_count": result.matchCount,
              "retrieval.trigger.considered_rule.count": result.consideredRules.length,
            }),
          )
        : Promise.resolve(undefined);
      const retrievalPromise = this.measureTraced(
        RETRIEVAL_TRACE_SPAN_NAMES.candidateRetrieval,
        buildQueryInterpretationTraceAttributes(interpretation.result),
        () => this.candidateRetrievalStage.execute(interpretation.result),
        buildCandidateRetrievalTraceAttributes,
      );
      const [retrieval, triggerAnalysis] = await Promise.all([retrievalPromise, triggerAnalysisPromise]);
      if (triggerAnalysis) {
        interpretation.result = {
          ...interpretation.result,
          triggerAnalysis: triggerAnalysis.result,
        };
        retrieval.result = {
          ...retrieval.result,
          triggerAnalysis: triggerAnalysis.result,
        };
      }
      const prepared = await this.measureTraced(
        RETRIEVAL_TRACE_SPAN_NAMES.candidatePreparation,
        buildCandidateRetrievalTraceAttributes(retrieval.result),
        () => this.candidatePreparationStage.execute(retrieval.result),
        buildCandidatePreparationTraceAttributes,
      );
      const selection = await this.measureTraced(
        RETRIEVAL_TRACE_SPAN_NAMES.contextSelection,
        buildCandidatePreparationTraceAttributes(prepared.result),
        () => this.contextSelectionStage.execute(prepared.result),
        buildContextSelectionTraceAttributes,
      );
      const prompt = await this.measureTraced(
        RETRIEVAL_TRACE_SPAN_NAMES.promptAssembly,
        buildContextSelectionTraceAttributes(selection.result),
        () => this.promptAssemblyStage.execute(selection.result),
        buildPromptAssemblyTraceAttributes,
      );
      const diagnostics = await this.measureTraced(
        RETRIEVAL_TRACE_SPAN_NAMES.diagnostics,
        buildPromptAssemblyTraceAttributes(prompt.result),
        () => this.retrievalDiagnosticsStage.execute(prompt.result),
        (result) => ({
          "retrieval.rewrite.status": result.rewriteStatus,
          "retrieval.rerank.status": result.rerankStatus,
          "retrieval.context.final.count": result.finalContextCount,
          "retrieval.fallback.applied": result.fallbackApplied,
          "retrieval.skipped": result.retrievalSkipped,
        }),
      );
      const trace = this.activityTraceBuilder.buildActivityTrace({
        traceStartedAtMs: input.traceStartedAtMs,
        context: input.context,
        interpretation,
        triggerAnalysis,
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
    });
  }

  async runWithoutRetrieval(input: RetrievalPipelineInterpretationResult): Promise<RetrievalPipelineResult> {
    return traceActiveSpan(
      RETRIEVAL_TRACE_SPAN_NAMES.pipelineNoRetrieval,
      buildRetrievalPipelineTraceAttributes(input.request),
      async () => {
        const responseBehavior = input.request.responseBehavior;
        const responseSettings = {
          citationDisplayEnabled: responseBehavior?.citationDisplayEnabled ?? true,
          suggestedQuestionsEnabled: input.context.result.settings.suggestedQuestionsEnabled,
          suggestedQuestionsCount: input.context.result.settings.suggestedQuestionsCount,
          customInstruction: responseBehavior?.customInstruction ?? input.context.result.settings.customInstruction,
          responseLanguagePolicy: input.interpretation.result.rewrittenQuery.responseLanguagePolicy ??
            "match_user_question",
          responseLanguage: input.interpretation.result.request.responseLanguage,
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
          retrievalSkipped: true,
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
      },
    );
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

  private async measureTraced<T>(
    name: string,
    attributes: TraceAttributes,
    runStage: () => Promise<T> | T,
    resultAttributes?: (result: T) => TraceAttributes,
  ): Promise<MeasuredStage<T>> {
    return this.measure(() => traceActiveSpan(name, attributes, runStage, resultAttributes));
  }
}
