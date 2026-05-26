import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ChatGateway } from "../../chat/contracts/index.js";
import type { RetrievalPipelineService } from "../../retrieval/public.js";
import type { RetrievalSettingsRecord } from "../../settings/contracts/retrieval.js";
import type { LlmCapabilityResolver } from "../../../shared/infra/llm/capabilityResolver.js";
import type { EvalRunModelOverride } from "../domain/types.js";
import type { EvalRetrievalRunnerPort } from "./evalRunner.js";
import type { EvalUsageMeter } from "./evalUsageMeter.js";

const UNKNOWN_MODEL = { provider: "unknown", model: "unknown" } as const;

/**
 * Wraps the existing retrieval pipeline and chat gateway so the eval module
 * can drive the same code path production assistant traffic uses, with an
 * explicit retrievalSettingsOverride, optional per-run model override, and
 * conversation history threaded from the snapshot.
 *
 * Resolves the chat capability once up front so the same (provider, model)
 * lands on:
 *   * the chat gateway via workspaceContext.capabilityOverride (so the
 *     gateway uses our pre-picked model, not a re-resolution),
 *   * the usage meter (so EE-side ledger has provider+model regardless of
 *     whether the gateway surfaces them), and
 *   * the returned resolvedConfig so EvalRunService can persist
 *     `modelProvider` + `modelId` on the run record.
 */
export class RetrievalPipelineEvalRunner implements EvalRetrievalRunnerPort {
  constructor(
    private readonly pipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly usageMeter: EvalUsageMeter,
    private readonly capabilityResolver: LlmCapabilityResolver,
  ) {}

  async retrieve(input: {
    workspaceId: string;
    query: string;
    history: MessageRecord[];
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }) {
    const result = await this.pipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history: input.history,
      retrievalSettingsOverride: input.retrievalSettingsOverride,
    });

    return {
      chunks: result.contexts.map((ctx, index) => ({
        chunkId: ctx.chunkId,
        documentId: ctx.documentId,
        title: ctx.title,
        rank: typeof ctx.promptPosition === "number" ? ctx.promptPosition : index,
        similarity: typeof ctx.similarity === "number" ? ctx.similarity : undefined,
      })),
      resolvedSettings: input.retrievalSettingsOverride,
    };
  }

  async answer(input: {
    workspaceId: string;
    accountId?: string | null;
    runId: string;
    query: string;
    history: MessageRecord[];
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

    const pipelineResult = await this.pipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history: input.history,
      retrievalSettingsOverride: input.retrievalSettingsOverride,
    });

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
      resolvedSettings: input.retrievalSettingsOverride,
      resolvedModel: { provider: resolvedProvider, model: resolvedModel },
    };
  }
}
