import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalSettingsService } from "../../settings/services/retrievalSettingsService.js";
import type { EmbeddingService } from "./embeddingService.js";
import type { PromptBuildResult } from "./promptBuilder.js";
import { CandidatePreparationService } from "./candidatePreparationService.js";
import { ConversationContextService } from "./conversationContextService.js";
import { PromptContextSelectorService } from "./promptContextSelectorService.js";
import { QueryRewriteService } from "./queryRewriteService.js";
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
    warmthLevel: number;
    citationDisplayEnabled: boolean;
  };
  diagnostics: RetrievalExecutionDiagnostics;
}

export class RetrievalPipelineService {
  private readonly retrievalContextStage: RetrievalContextStage;
  private readonly queryInterpretationStage: QueryInterpretationStage;
  private readonly candidateRetrievalStage: CandidateRetrievalStage;
  private readonly candidatePreparationStage: CandidatePreparationStage;
  private readonly contextSelectionStage: ContextSelectionStage;
  private readonly promptAssemblyStage: PromptAssemblyStage;
  private readonly retrievalDiagnosticsStage: RetrievalDiagnosticsStage;

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
      attributeMatchScoringService,
    );
    this.contextSelectionStage = new ContextSelectionStageService(rerankService, promptContextSelectorService);
    this.promptAssemblyStage = new PromptAssemblyStageService(promptBuilder);
    this.retrievalDiagnosticsStage = new RetrievalDiagnosticsStageService(retrievalExecutionTelemetryService);
  }

  async run(input: RetrievalPipelineRequest): Promise<RetrievalPipelineResult> {
    const context = await this.retrievalContextStage.execute(input);
    const interpretation = await this.queryInterpretationStage.execute(context);
    const retrieval = await this.candidateRetrievalStage.execute(interpretation);
    const prepared = await this.candidatePreparationStage.execute(retrieval);
    const selection = await this.contextSelectionStage.execute(prepared);
    const prompt = this.promptAssemblyStage.execute(selection);
    const diagnostics = this.retrievalDiagnosticsStage.execute(prompt);

    return {
      rewrittenQuery: prompt.activeQuery,
      contexts: prompt.contexts,
      prompt: prompt.prompt,
      citations: prompt.citations,
      responseSettings: prompt.responseSettings,
      diagnostics,
    };
  }
}
