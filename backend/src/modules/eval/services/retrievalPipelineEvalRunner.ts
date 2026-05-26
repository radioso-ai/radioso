import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ChatGateway } from "../../chat/contracts/index.js";
import type { RetrievalPipelineService } from "../../retrieval/public.js";
import type { RetrievalSettingsRecord } from "../../settings/contracts/retrieval.js";
import type { EvalRetrievalRunnerPort } from "./evalRunner.js";
import type { EvalUsageMeter } from "./evalUsageMeter.js";

/**
 * Wraps the existing retrieval pipeline and chat gateway so the eval module
 * can drive the same code path production assistant traffic uses, with an
 * explicit retrievalSettingsOverride and conversation history threaded from
 * the snapshot.
 *
 * `retrieve` is retrieval-only and skips the LLM call. `answer` runs the
 * full pipeline and returns the generated text alongside the chunks. The
 * full-pipeline call also records a ModelUsageEvent so EE-side metering
 * can bucket eval LLM spend distinctly from production assistant traffic.
 */
export class RetrievalPipelineEvalRunner implements EvalRetrievalRunnerPort {
  constructor(
    private readonly pipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
    private readonly usageMeter: EvalUsageMeter,
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
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }) {
    const pipelineResult = await this.pipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history: input.history,
      retrievalSettingsOverride: input.retrievalSettingsOverride,
    });

    let generated = "";
    let status: "succeeded" | "failed" = "succeeded";
    let errorCode: string | null = null;
    try {
      generated = await this.chatGateway.answer({
        query: input.query,
        history: input.history,
        prompt: pipelineResult.prompt,
        systemPrompt: pipelineResult.systemPrompt,
        workspaceContext: { workspaceId: input.workspaceId },
      });
    } catch (err) {
      status = "failed";
      errorCode = err instanceof Error ? err.message.slice(0, 200) : "unknown";
      throw err;
    } finally {
      // Record one usage event per full-assistant LLM call, success OR failure.
      // Failed calls still hit the provider, so EE-side metering must see them.
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
      );
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
    };
  }
}
