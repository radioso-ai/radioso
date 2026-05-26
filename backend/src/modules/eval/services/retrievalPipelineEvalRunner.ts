import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ChatGateway } from "../../chat/contracts/index.js";
import type { RetrievalPipelineRequest, RetrievalPipelineService } from "../../retrieval/public.js";
import type {
  RetrievalSettingsRecord,
  RetrievalSettingsSnapshot,
} from "../../settings/contracts/retrieval.js";
import { freezeRetrievalSettings } from "../../settings/contracts/retrieval.js";
import type { RetrievalSettingsService } from "../../settings/contracts/services.js";
import type { LlmCapabilityResolver } from "../../../shared/infra/llm/capabilityResolver.js";
import type { EvalRunModelOverride } from "../domain/types.js";
import type { EvalReplayContext, EvalRetrievalRunnerPort } from "./evalRunner.js";
import type { EvalUsageMeter } from "./evalUsageMeter.js";

const UNKNOWN_MODEL = { provider: "unknown", model: "unknown" } as const;

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
 *   * Return the *fully resolved* retrieval settings actually used (the
 *     workspace's settings record + override, merged and frozen) so the run
 *     row is auditable on its own — not just the delta override.
 */
export class RetrievalPipelineEvalRunner implements EvalRetrievalRunnerPort {
  constructor(
    private readonly pipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly usageMeter: EvalUsageMeter,
    private readonly capabilityResolver: LlmCapabilityResolver,
    private readonly retrievalSettings: RetrievalSettingsService,
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
      })),
      resolvedSettings: await this.resolveSettingsSnapshot(
        input.workspaceId,
        input.retrievalSettingsOverride,
      ),
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
        capabilityOverride: (input.modelOverride ?? null) as never,
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
      }),
    );

    let generated = "";
    let status: "succeeded" | "failed" = "succeeded";
    let errorCode: string | null = null;
    let callError: unknown = null;
    try {
      generated = await this.chatGateway.answer({
        query: input.query,
        history: input.history,
        prompt: pipelineResult.prompt,
        systemPrompt: pipelineResult.systemPrompt,
        workspaceContext: {
          workspaceId: input.workspaceId,
          capabilityOverride: (input.modelOverride ?? null) as never,
        },
      });
    } catch (err) {
      callError = err;
      status = "failed";
      errorCode = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    } finally {
      await this.usageMeter.record(
        {
          workspaceId: input.workspaceId,
          accountId: input.accountId ?? null,
          runId: input.runId,
          operation: "full_assistant_answer",
          attemptKey: "answer",
        },
        {
          promptText: `${pipelineResult.systemPrompt ?? ""}\n\n${pipelineResult.prompt}`,
          responseText: generated,
          status,
          errorCode,
        },
        { provider: resolvedProvider, model: resolvedModel },
      );
    }

    if (callError) {
      throw callError;
    }

    return {
      chunks: pipelineResult.contexts.map((ctx, index) => ({
        chunkId: ctx.chunkId,
        documentId: ctx.documentId,
        title: ctx.title,
        rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
        similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
      })),
      answer: generated,
      composedInstructions: pipelineResult.systemPrompt,
      resolvedSettings: await this.resolveSettingsSnapshot(
        input.workspaceId,
        input.retrievalSettingsOverride,
      ),
      resolvedModel: { provider: resolvedProvider, model: resolvedModel },
    };
  }

  private buildPipelineRequest(input: {
    workspaceId: string;
    query: string;
    history: MessageRecord[];
    context?: EvalReplayContext;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }): RetrievalPipelineRequest {
    const agent = input.context?.agent ?? null;
    const customInstruction =
      input.context?.customInstructionOverride !== undefined
        ? input.context.customInstructionOverride
        : (agent?.customInstruction ?? "");
    const responseBehavior = agent
      ? {
          customInstruction,
          suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
          suggestedQuestionsCount: 3,
        }
      : customInstruction
        ? { customInstruction, suggestedQuestionsEnabled: true, suggestedQuestionsCount: 3 }
        : undefined;

    return {
      workspaceId: input.workspaceId,
      query: input.query,
      history: input.history,
      responseIdentity: agent && agent.name.trim() ? { name: agent.name } : undefined,
      responseBehavior,
      responseBehaviorEnabled: Boolean(responseBehavior),
      sourceScope: agent?.sourceScope,
      retrievalSettingsOverride: input.retrievalSettingsOverride,
    };
  }

  private async resolveSettingsSnapshot(
    workspaceId: string,
    override: Partial<RetrievalSettingsRecord> | undefined,
  ): Promise<RetrievalSettingsSnapshot | undefined> {
    try {
      const base = await this.retrievalSettings.getForWorkspace(workspaceId);
      const merged: RetrievalSettingsRecord = override
        ? { ...base, ...override, workspaceId: base.workspaceId }
        : base;
      return freezeRetrievalSettings(merged);
    } catch {
      // Auditing must not break run execution. The run row will simply have
      // no resolved settings recorded; EE-side audit can flag it.
      return undefined;
    }
  }
}
