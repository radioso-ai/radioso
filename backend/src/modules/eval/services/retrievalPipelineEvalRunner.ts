import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { appendConversationSummaryStage, type ChatGateway } from "../../chat/contracts/index.js";
import type {
  CitationEvidence,
  PresentedAnswer,
} from "../../chat/contracts/answerTypes.js";
import {
  composeGroundedAnswerSystemPrompt,
  computeGroundingSummary,
  BlankChatAnswerError,
  GROUNDED_ANSWER_RESPONSE_FORMAT,
  parseGroundedAnswerEnvelope,
} from "../../chat/retrievalSupport.js";
import {
  resolveContextSourceUrl,
  type FinalPromptContext,
  type RetrievalDefaultsProvider,
  type RetrievalPipelineRequest,
  type RetrievalPipelineService,
  type SkillSettingsResolver,
} from "../../retrieval/public.js";
import type {
  RetrievalSettingsRecord,
  RetrievalSettingsSnapshot,
} from "../../settings/contracts/retrieval.js";
import { freezeRetrievalSettings } from "../../settings/contracts/retrieval.js";
import type { LlmCapabilityResolver } from "../../../shared/infra/llm/capabilityResolver.js";
import type { EvalRunModelOverride } from "../domain/types.js";
import type { EvalReplayContext, EvalRetrievalRunnerPort } from "./evalRunner.js";

const UNKNOWN_MODEL = { provider: "unknown", model: "unknown" } as const;

export interface EvalAnswerPresentationPort {
  present(input: { answer: string; citations: CitationEvidence[] }): PresentedAnswer;
}

const toCitationEvidence = (contexts: FinalPromptContext[]): CitationEvidence[] =>
  contexts.map((context) => {
    const evidence: CitationEvidence = {
      documentId: context.documentId,
      chunkId: context.chunkId,
      title: context.title,
      content: context.content,
    };
    const sourceUrl = resolveContextSourceUrl(context.metadata);
    if (sourceUrl) {
      evidence.sourceUrl = sourceUrl;
    }
    return evidence;
  });

/**
 * Wraps the existing retrieval pipeline and chat gateway so the eval module
 * can drive the same code path production assistant traffic uses.
 *
 * Responsibilities the runner owns and the bare retrieval pipeline doesn't:
 *   * Thread the snapshot's frozen agent context (responseIdentity,
 *     customInstruction, suggestedQuestions, sourceScope) into the pipeline
 *     input so the eval replay applies the same persona, instructions, and
 *     document scope the original turn ran with.
 *   * Apply the operator's assistantInstructionsOverride on top of the
 *     agent's baked-in custom instruction.
 *   * Resolve the chat capability once up front (with optional model
 *     override) and thread the same (provider, model) to the gateway, the
 *     usage meter, and the returned resolvedConfig.
 *   * Return the *fully resolved* retrieval settings actually used (system
 *     defaults + agent skill settings + override, merged and frozen) so the run
 *     row is auditable on its own — not just the delta override.
 */
export class RetrievalPipelineEvalRunner implements EvalRetrievalRunnerPort {
  constructor(
    private readonly pipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly capabilityResolver: LlmCapabilityResolver,
    private readonly retrievalDefaultsProvider: RetrievalDefaultsProvider,
    private readonly answerPresentation: EvalAnswerPresentationPort,
    private readonly skillSettingsResolver?: SkillSettingsResolver,
  ) {}

  async retrieve(input: {
    workspaceId: string;
    query: string;
    history: MessageRecord[];
    context?: EvalReplayContext;
    // Retrieval composes no grounded prompt, so the frozen summary (#866) has no
    // injection point here; accepted for port symmetry with `answer`.
    conversationSummary?: string;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }) {
    const result = await this.pipeline.run(
      this.buildPipelineRequest({
        workspaceId: input.workspaceId,
        query: input.query,
        history: input.history,
        context: input.context,
        retrievalSettingsOverride: input.retrievalSettingsOverride,
      }),
    );

    return {
      chunks: result.contexts.map((ctx, index) => ({
        chunkId: ctx.chunkId,
        documentId: ctx.documentId,
        title: ctx.title,
        rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
        similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
        fusedScore: typeof ctx.fusedScore === "number" ? ctx.fusedScore : undefined,
        semanticScore: typeof ctx.semanticScore === "number" ? ctx.semanticScore : undefined,
        lexicalScore: typeof ctx.lexicalScore === "number" ? ctx.lexicalScore : undefined,
        lexicalRankScore: typeof ctx.lexicalRankScore === "number" ? ctx.lexicalRankScore : undefined,
        metadata: ctx.metadata,
      })),
      resolvedSettings: await this.resolveSettingsSnapshot(
        input.workspaceId,
        input.context?.agent?.skillSettings,
        input.retrievalSettingsOverride,
      ),
      activityTrace: result.trace,
    };
  }

  async answer(input: {
    workspaceId: string;
    accountId?: string | null;
    runId: string;
    query: string;
    history: MessageRecord[];
    context?: EvalReplayContext;
    // Frozen rolling summary (#866) injected into the grounded system prompt so the
    // eval'd answer sees the same pre-window context a live turn would.
    conversationSummary?: string;
    modelOverride?: EvalRunModelOverride;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }) {
    // Resolve the model once up front so the gateway uses exactly what we
    // record on the run + usage event. The override (if provided) takes
    // precedence over the workspace's chat capability.
    let resolvedProvider: string = UNKNOWN_MODEL.provider;
    let resolvedModel: string = UNKNOWN_MODEL.model;
    try {
      const config = await this.capabilityResolver.resolve("chat", {
        workspaceId: input.workspaceId,
        capabilityOverride: input.modelOverride ?? null,
      });
      resolvedProvider = config.provider;
      resolvedModel = config.model;
    } catch {
      // Recording continues with unknown/unknown; gateway will surface its
      // own resolution error when called below.
    }

    const pipelineResult = await this.pipeline.run(
      this.buildPipelineRequest({
        workspaceId: input.workspaceId,
        query: input.query,
        history: input.history,
        context: input.context,
        retrievalSettingsOverride: input.retrievalSettingsOverride,
        usageContext: {
          accountId: input.accountId ?? null,
          workspaceId: input.workspaceId,
          requestId: input.runId,
          surface: "eval",
          attemptKey: "retrieval_pipeline",
        },
      }),
    );

    const composedSystemPrompt = composeGroundedAnswerSystemPrompt({
      baseSystemPrompt: pipelineResult.systemPrompt,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 0,
      hasRetrievedContexts: pipelineResult.contexts.length > 0,
      conversationSummary: input.conversationSummary,
      conversationIntentSnapshot: {
        recentTurns: input.history
          .filter((message) => message.role !== "system")
          .slice(-6)
          .map((message) => ({ role: message.role, content: message.content })),
        activeSubject: input.query,
        activeGoal: input.query,
      },
    }).systemPrompt;
    let generated = "";
    let callError: unknown = null;
    try {
      generated = await this.chatGateway.answer({
        query: input.query,
        history: input.history,
        prompt: pipelineResult.prompt,
        systemPrompt: composedSystemPrompt,
        workspaceContext: {
          workspaceId: input.workspaceId,
          capabilityOverride: input.modelOverride ?? null,
        },
        usageContext: {
          accountId: input.accountId ?? null,
          workspaceId: input.workspaceId,
          requestId: input.runId,
          surface: "eval",
          operation: "full_assistant",
          attemptKey: "answer",
        },
        generation: { responseFormat: GROUNDED_ANSWER_RESPONSE_FORMAT },
      });
    } catch (err) {
      callError = err;
    }

    if (callError) {
      throw callError;
    }

    const envelope = parseGroundedAnswerEnvelope(generated);
    if (!envelope.answer.trim()) {
      throw new BlankChatAnswerError();
    }
    const citationEvidence = toCitationEvidence(pipelineResult.contexts);
    const presented = this.answerPresentation.present({
      answer: envelope.answer,
      citations: citationEvidence,
    });
    const groundingSummary = computeGroundingSummary({
      body: envelope.answer,
      envelope,
      contextCount: pipelineResult.contexts.length,
    });

    return {
      chunks: pipelineResult.contexts.map((ctx, index) => ({
        chunkId: ctx.chunkId,
        documentId: ctx.documentId,
        title: ctx.title,
        rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
        similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
        fusedScore: typeof ctx.fusedScore === "number" ? ctx.fusedScore : undefined,
        semanticScore: typeof ctx.semanticScore === "number" ? ctx.semanticScore : undefined,
        lexicalScore: typeof ctx.lexicalScore === "number" ? ctx.lexicalScore : undefined,
        lexicalRankScore: typeof ctx.lexicalRankScore === "number" ? ctx.lexicalRankScore : undefined,
        metadata: ctx.metadata,
      })),
      answer: presented.answer,
      citations: presented.citations,
      answerSegments: presented.answerSegments,
      groundingSummary,
      composedInstructions: composedSystemPrompt,
      resolvedSettings: await this.resolveSettingsSnapshot(
        input.workspaceId,
        input.context?.agent?.skillSettings,
        input.retrievalSettingsOverride,
      ),
      resolvedModel: { provider: resolvedProvider, model: resolvedModel },
      // Surface the frozen summary (#866) that was injected into the grounded prompt
      // above, so the eval activity trace shows the same pre-window context an
      // operator sees on a live turn. Behavior-preserving when no summary was frozen.
      activityTrace: appendConversationSummaryStage(pipelineResult.trace, input.conversationSummary),
    };
  }

  private buildPipelineRequest(input: {
    workspaceId: string;
    query: string;
    history: MessageRecord[];
    context?: EvalReplayContext;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
    usageContext?: RetrievalPipelineRequest["usageContext"];
  }): RetrievalPipelineRequest {
    const agent = input.context?.agent ?? null;
    const customInstruction =
      input.context?.customInstructionOverride !== undefined
        ? input.context.customInstructionOverride
        : (agent?.customInstruction ?? "");
    const responseBehavior = agent
      ? {
          customInstruction,
          citationDisplayEnabled: agent.citationDisplayEnabled,
        }
      : customInstruction
        ? { customInstruction, citationDisplayEnabled: true }
        : undefined;

    return {
      workspaceId: input.workspaceId,
      query: input.query,
      history: input.history,
      responseIdentity: agent && agent.name.trim() ? { name: agent.name } : undefined,
      responseBehavior,
      responseBehaviorEnabled: Boolean(responseBehavior),
      sourceScope: agent?.sourceScope,
      agentSkillSettings: agent?.skillSettings,
      retrievalSettingsOverride: input.retrievalSettingsOverride,
      usageContext: input.usageContext,
    };
  }

  private async resolveSettingsSnapshot(
    workspaceId: string,
    agentSkillSettings: Record<string, unknown> | undefined,
    override: Partial<RetrievalSettingsRecord> | undefined,
  ): Promise<RetrievalSettingsSnapshot | undefined> {
    try {
      const base = this.retrievalDefaultsProvider.getDefaults(workspaceId);
      const agentResolved = this.skillSettingsResolver
        ? this.skillSettingsResolver.resolve(
            "retrieval.answer",
            base,
            agentSkillSettings?.["retrieval.answer"],
          )
        : base;
      const merged: RetrievalSettingsRecord = override
        ? { ...agentResolved, ...override, workspaceId: base.workspaceId }
        : agentResolved;
      return freezeRetrievalSettings(merged);
    } catch {
      // Auditing must not break run execution. The run row will simply have
      // no resolved settings recorded; EE-side audit can flag it.
      return undefined;
    }
  }
}
