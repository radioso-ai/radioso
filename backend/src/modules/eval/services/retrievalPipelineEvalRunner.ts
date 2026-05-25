import type { ChatGateway } from "../../chat/contracts/index.js";
import type { RetrievalPipelineService } from "../../retrieval/public.js";
import type { RetrievalSettingsRecord } from "../../settings/contracts/retrieval.js";
import type { EvalRetrievalRunnerPort } from "./evalRunner.js";

/**
 * Wraps the existing retrieval pipeline and chat gateway so the eval module
 * can drive the same code path production assistant traffic uses, with an
 * explicit retrievalSettingsOverride and an empty history (the snapshot's
 * history could be wired in later if needed).
 *
 * `retrieve` is retrieval-only and skips the LLM call. `answer` runs the
 * full pipeline and returns the generated text alongside the chunks.
 */
export class RetrievalPipelineEvalRunner implements EvalRetrievalRunnerPort {
  constructor(
    private readonly pipeline: RetrievalPipelineService,
    private readonly chatGateway: ChatGateway,
  ) {}

  async retrieve(input: {
    workspaceId: string;
    query: string;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }) {
    const result = await this.pipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history: [],
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
    query: string;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }) {
    const pipelineResult = await this.pipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history: [],
      retrievalSettingsOverride: input.retrievalSettingsOverride,
    });

    const generated = await this.chatGateway.answer({
      query: input.query,
      history: [],
      prompt: pipelineResult.prompt,
      systemPrompt: pipelineResult.systemPrompt,
      workspaceContext: { workspaceId: input.workspaceId },
    });

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
