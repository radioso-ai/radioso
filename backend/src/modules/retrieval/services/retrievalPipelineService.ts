import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalSettingsService } from "../../settings/services/retrievalSettingsService.js";
import type { EmbeddingService } from "./embeddingService.js";
import type { PromptBuildResult } from "./promptBuilder.js";
import { CandidatePreparationService } from "./candidatePreparationService.js";
import { ConversationContextService } from "./conversationContextService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import { QueryRewriteService } from "./queryRewriteService.js";
import { SemanticQueryConstraintService } from "./semanticQueryConstraintService.js";
import { RerankService } from "./rerankService.js";
import { RetrievalExecutionTelemetryService } from "./retrievalExecutionTelemetryService.js";
import type { RetrievalExecutionDiagnostics } from "../domain/retrievalPipelineTypes.js";
import { AttributeMatchScoringService } from "./attributeMatchScoringService.js";
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
  CandidatePreparationStage,
  CandidateRetrievalStage,
  ContextSelectionStage,
  PromptAssemblyStage,
  QueryInterpretationStage,
  RetrievalContextStage,
  RetrievalPipelineRequest,
  RetrievalDiagnosticsStage,
} from "./retrievalPipelineStages.js";

export interface RetrievalPipelineResult {
  rewrittenQuery: string;
  contexts: import("../domain/retrievalPipelineTypes.js").FinalPromptContext[];
  prompt: string;
  citations: PromptBuildResult["citations"];
  responseSettings: {
    citationDisplayEnabled: boolean;
    answerSupportPolicy: import("../../settings/domain/retrievalSettings.js").AnswerSupportPolicy;
    responseLanguagePolicy?: import("../domain/retrievalPipelineTypes.js").ResponseLanguagePolicy;
  };
  diagnostics: RetrievalExecutionDiagnostics;
  trace: import("../domain/retrievalPipelineTypes.js").RetrievalTrace;
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
    attributeMatchScoringService: AttributeMatchScoringService,
    rerankService: RerankService,
    promptContextSelectorService: PromptContextSelectorService,
    promptBuilder: PromptBuilder,
    retrievalExecutionTelemetryService: RetrievalExecutionTelemetryService,
    semanticQueryConstraintService: SemanticQueryConstraintService = new SemanticQueryConstraintService(),
  ) {
    this.retrievalContextStage = new RetrievalContextStageService(
      retrievalSettingsService,
      conversationContextService,
    );
    this.queryInterpretationStage = new QueryInterpretationStageService(
      queryRewriteService,
      semanticQueryConstraintService,
    );
    this.candidateRetrievalStage = new CandidateRetrievalStageService(
      embeddingService,
      vectorSearch,
      lexicalSearch,
    );
    this.candidatePreparationStage = new CandidatePreparationStageService(
      candidatePreparationService,
      attributeMatchScoringService,
      new MetadataRuleScoringService(),
    );
    this.contextSelectionStage = new ContextSelectionStageService(rerankService, promptContextSelectorService);
    this.promptAssemblyStage = new PromptAssemblyStageService(promptBuilder);
    this.retrievalDiagnosticsStage = new RetrievalDiagnosticsStageService(retrievalExecutionTelemetryService);
  }

  async run(input: RetrievalPipelineRequest): Promise<RetrievalPipelineResult> {
    const toIso = (value: number) => new Date(value).toISOString();
    const traceStartedAtMs = Date.now();
    const measure = async <T>(runStage: () => Promise<T> | T) => {
      const startedAt = Date.now();
      const result = await runStage();
      const finishedAt = Date.now();
      return {
        result,
        startedAt,
        durationMs: finishedAt - startedAt,
      };
    };

    const context = await measure(() => this.retrievalContextStage.execute(input));
    const interpretation = await measure(() => this.queryInterpretationStage.execute(context.result));
    const retrieval = await measure(() => this.candidateRetrievalStage.execute(interpretation.result));
    const prepared = await measure(() => this.candidatePreparationStage.execute(retrieval.result));
    const selection = await measure(() => this.contextSelectionStage.execute(prepared.result));
    const prompt = await measure(() => this.promptAssemblyStage.execute(selection.result));
    const diagnostics = await measure(() => this.retrievalDiagnosticsStage.execute(prompt.result));
    const traceCompletedAtMs = Date.now();
    const lexicalDurationMs = Math.max(0, Math.round(retrieval.durationMs * 0.35));
    const semanticDurationMs = Math.max(0, retrieval.durationMs - lexicalDurationMs);
    const trace = this.retrievalTraceAssembler.assemble({
      prompt: prompt.result,
      diagnostics: diagnostics.result,
      timings: {
        traceStartedAt: toIso(traceStartedAtMs),
        traceCompletedAt: toIso(traceCompletedAtMs),
        totalDurationMs: traceCompletedAtMs - traceStartedAtMs,
        retrievalContext: {
          startedAt: toIso(context.startedAt),
          durationMs: context.durationMs,
        },
        queryInterpretation: {
          startedAt: toIso(interpretation.startedAt),
          durationMs: interpretation.durationMs,
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
      prompt: prompt.result.prompt,
      citations: prompt.result.citations,
      responseSettings: prompt.result.responseSettings,
      diagnostics: diagnostics.result,
      trace,
    };
  }
}
