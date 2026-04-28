import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalSettingsService } from "../../settings/services/retrievalSettingsService.js";
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
import type { VectorSearchPort } from "../infra/vectorSearch.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import { PromptBuilder } from "./promptBuilder.js";
import { CandidateRetrievalStageService } from "./candidateRetrievalStage.js";
import { CandidatePreparationStageService } from "./candidatePreparationStage.js";
import { ContextSelectionStageService } from "./contextSelectionStage.js";
import { PromptAssemblyStageService } from "./promptAssemblyStage.js";
import { QueryInterpretationStageService } from "./queryInterpretationStage.js";
import { RetrievalContextStageService } from "./retrievalContextStage.js";
import { RetrievalDiagnosticsStageService } from "./retrievalDiagnosticsStage.js";
import { RetrievalTraceAssembler } from "./retrievalTraceAssembler.js";
import { MetadataRuleScoringService } from "./metadataRuleScoringService.js";
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
    answerSupportPolicy: import("../../settings/domain/retrievalSettings.js").AnswerSupportPolicy;
    conversationMode: import("../../settings/domain/retrievalSettings.js").ConversationMode;
    suggestedQuestionsEnabled: boolean;
    suggestedQuestionsCount: number;
    customInstruction?: string;
    responseLanguagePolicy?: import("../domain/retrievalPipelineTypes.js").ResponseLanguagePolicy;
  };
  diagnostics: RetrievalExecutionDiagnostics;
  trace: import("../domain/retrievalPipelineTypes.js").RetrievalTrace;
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

export class RetrievalPipelineService {
  private readonly retrievalContextStage: RetrievalContextStage;
  private readonly queryInterpretationStage: QueryInterpretationStage;
  private readonly candidateRetrievalStage: CandidateRetrievalStage;
  private readonly candidatePreparationStage: CandidatePreparationStage;
  private readonly contextSelectionStage: ContextSelectionStage;
  private readonly promptAssemblyStage: PromptAssemblyStage;
  private readonly retrievalDiagnosticsStage: RetrievalDiagnosticsStage;
  private readonly retrievalTraceAssembler = new RetrievalTraceAssembler();

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
    const toIso = (value: number) => new Date(value).toISOString();
    const retrieval = await this.measure(() => this.candidateRetrievalStage.execute(input.interpretation.result));
    const prepared = await this.measure(() => this.candidatePreparationStage.execute(retrieval.result));
    const selection = await this.measure(() => this.contextSelectionStage.execute(prepared.result));
    const prompt = await this.measure(() => this.promptAssemblyStage.execute(selection.result));
    const diagnostics = await this.measure(() => this.retrievalDiagnosticsStage.execute(prompt.result));
    const traceCompletedAtMs = Date.now();
    const lexicalDurationMs = Math.max(0, Math.round(retrieval.durationMs * 0.35));
    const semanticDurationMs = Math.max(0, retrieval.durationMs - lexicalDurationMs);
    const trace = this.retrievalTraceAssembler.assemble({
      prompt: prompt.result,
      diagnostics: diagnostics.result,
      timings: {
        traceStartedAt: toIso(input.traceStartedAtMs),
        traceCompletedAt: toIso(traceCompletedAtMs),
        totalDurationMs: traceCompletedAtMs - input.traceStartedAtMs,
        retrievalContext: {
          startedAt: toIso(input.context.startedAt),
          durationMs: input.context.durationMs,
        },
        queryInterpretation: {
          startedAt: toIso(input.interpretation.startedAt),
          durationMs: input.interpretation.durationMs,
        },
        semanticRetrieval: {
          startedAt: toIso(retrieval.startedAt),
          durationMs: semanticDurationMs,
        },
        lexicalRetrieval: {
          startedAt: toIso(retrieval.startedAt + semanticDurationMs),
          durationMs: lexicalDurationMs,
        },
        candidatePreparation: {
          startedAt: toIso(prepared.startedAt),
          durationMs: prepared.durationMs,
        },
        contextSelection: {
          startedAt: toIso(selection.startedAt),
          durationMs: selection.durationMs,
        },
        promptAssembly: {
          startedAt: toIso(prompt.startedAt),
          durationMs: prompt.durationMs,
        },
        diagnostics: {
          startedAt: toIso(diagnostics.startedAt),
          durationMs: diagnostics.durationMs,
        },
      },
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
    const responseSettings = {
      citationDisplayEnabled: input.context.result.settings.citationDisplayEnabled,
      answerSupportPolicy: input.context.result.settings.answerSupportPolicy,
      conversationMode: input.context.result.settings.conversationMode,
      suggestedQuestionsEnabled: input.context.result.settings.suggestedQuestionsEnabled,
      suggestedQuestionsCount: input.context.result.settings.suggestedQuestionsCount,
      customInstruction: input.context.result.settings.customInstruction,
      responseLanguagePolicy: input.interpretation.result.rewrittenQuery.responseLanguagePolicy ?? "match_user_question",
    };
    const diagnostics: RetrievalExecutionDiagnostics = {
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
    const traceCompletedAtMs = Date.now();
    const toIso = (value: number) => new Date(value).toISOString();

    return {
      rewrittenQuery: input.request.query,
      contexts: [],
      systemPrompt: "",
      prompt: "",
      citations: [],
      responseIdentity: input.request.responseIdentity ?? null,
      responseSettings,
      diagnostics,
      trace: {
        traceId: randomUUID(),
        startedAt: toIso(input.traceStartedAtMs),
        completedAt: toIso(traceCompletedAtMs),
        totalDurationMs: traceCompletedAtMs - input.traceStartedAtMs,
        stages: [
          {
            stageId: "context",
            kind: "context",
            label: "Context",
            status: "applied",
            startedAt: toIso(input.context.startedAt),
            durationMs: input.context.durationMs,
            inputs: {
              query: input.request.query,
              historyMessageCount: input.request.history.length,
              metadataFilterKeys: Object.keys(input.request.metadataFilter ?? {}),
            },
            outputs: {
              selectedHistoryCount: input.context.result.contextWindow.selectedMessages.length,
              historyTruncated: input.context.result.contextWindow.truncated,
              selectionReason: input.context.result.contextWindow.selectionReason,
            },
          },
          {
            stageId: "interpretation",
            kind: "query_interpretation",
            label: "Query interpretation",
            status: input.interpretation.result.rewrittenQuery.status === "fallback"
              ? "fallback"
              : input.interpretation.result.rewrittenQuery.status === "rejected"
                ? "rejected"
                : input.interpretation.result.rewrittenQuery.status === "skipped"
                  ? "skipped"
                  : "applied",
            startedAt: toIso(input.interpretation.startedAt),
            durationMs: input.interpretation.durationMs,
            inputs: {
              originalQuery: input.request.query,
            },
            outputs: {
              responseIntent: input.interpretation.result.responseIntent,
              retrievalSkipped: true,
              promptHistoryCount: input.interpretation.result.promptHistory.length,
              responseLanguagePolicy: input.interpretation.result.rewrittenQuery.responseLanguagePolicy,
              continuityDecision: input.interpretation.result.continuityDecision,
            },
            metrics: {
              intentConfidence: Number(input.interpretation.result.rewrittenQuery.confidence.toFixed(3)),
            },
            reason: "Retrieval was intentionally skipped for a non-retrieval chat turn.",
          },
          {
            stageId: "diagnostics",
            kind: "diagnostics",
            label: "Diagnostics",
            status: "skipped",
            startedAt: toIso(traceCompletedAtMs),
            durationMs: 0,
            outputs: {
              responseIntent: diagnostics.responseIntent,
              retrievalSkipped: diagnostics.retrievalSkipped,
              continuityDecision: diagnostics.continuityDecision,
            },
          },
        ],
        links: [
          { fromStageId: "context", toStageId: "interpretation", kind: "sequence" },
          { fromStageId: "interpretation", toStageId: "diagnostics", kind: "sequence" },
        ],
      },
    };
  }

  private resolveRequest(input: RetrievalPipelineRequest): RetrievalPipelineRequest {
    return {
      ...input,
      responseIdentity: input.responseIdentity ?? null,
    };
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
