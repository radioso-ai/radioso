import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ChatGateway } from "../../chat/contracts/index.js";
import type {
  CitationEvidence,
  NormalizedPresentedAnswer,
  PresentedAnswer,
} from "../../chat/contracts/answerTypes.js";
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
  normalize(input: { answer: string; citations: CitationEvidence[] }): NormalizedPresentedAnswer;
  present(input: { answer: string; citations: CitationEvidence[] }): PresentedAnswer;
  resolveCitationArtifacts(
    presented: PresentedAnswer,
    normalized: NormalizedPresentedAnswer,
    citationEvidence: CitationEvidence[],
  ): Pick<PresentedAnswer, "citations" | "answerSegments">;
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

    let generated = "";
    let callError: unknown = null;
    try {
      generated = await this.chatGateway.answer({
        query: input.query,
        history: input.history,
        prompt: pipelineResult.prompt,
        systemPrompt: pipelineResult.systemPrompt,
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
      });
    } catch (err) {
      callError = err;
    }

    if (callError) {
      throw callError;
    }

    const citationEvidence = toCitationEvidence(pipelineResult.contexts);
    const normalized = this.answerPresentation.normalize({
      answer: generated,
      citations: citationEvidence,
    });
    const presented = this.answerPresentation.present({
      answer: generated,
      citations: citationEvidence,
    });
    const citationArtifacts = this.answerPresentation.resolveCitationArtifacts(presented, normalized, citationEvidence);

    return {
      chunks: pipelineResult.contexts.map((ctx, index) => ({
        chunkId: ctx.chunkId,
        documentId: ctx.documentId,
        title: ctx.title,
        rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
        similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
        metadata: ctx.metadata,
      })),
      answer: presented.answer,
      citations: citationArtifacts.citations,
      answerSegments: citationArtifacts.answerSegments,
      composedInstructions: pipelineResult.systemPrompt,
      resolvedSettings: await this.resolveSettingsSnapshot(
        input.workspaceId,
        input.context?.agent?.skillSettings,
        input.retrievalSettingsOverride,
      ),
      resolvedModel: { provider: resolvedProvider, model: resolvedModel },
      activityTrace: pipelineResult.trace,
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
