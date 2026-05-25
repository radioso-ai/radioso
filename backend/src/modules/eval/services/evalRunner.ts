import type { RetrievalSettingsRecord } from "../../settings/contracts/retrieval.js";
import type { EvalRunRetrievedChunk, EvalSnapshot } from "../domain/types.js";

/**
 * Narrow port the eval module uses to drive the assistant pipeline.
 *
 * - `retrieve` runs only the retrieval pipeline (no LLM call). Cheap and
 *   deterministic; used for retrieval_only run mode.
 * - `answer` runs the full pipeline: retrieval, instruction composition,
 *   and the chat LLM call. Used for full_assistant run mode and answer-
 *   based assertions.
 *
 * The concrete implementation wraps the existing RetrievalPipelineService
 * and ChatGateway. The eval module never depends on those contracts
 * directly — only on this port shape.
 */
export interface EvalRetrievalRunnerPort {
  retrieve(input: {
    workspaceId: string;
    query: string;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }): Promise<{ chunks: EvalRunRetrievedChunk[]; resolvedSettings?: Partial<RetrievalSettingsRecord> }>;

  answer(input: {
    workspaceId: string;
    query: string;
    retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>;
  }): Promise<{
    chunks: EvalRunRetrievedChunk[];
    answer: string;
    composedInstructions?: string;
    resolvedSettings?: Partial<RetrievalSettingsRecord>;
  }>;
}

export const findLastUserMessage = (snapshot: EvalSnapshot): string | null => {
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const m = snapshot.messages[i];
    if (m && m.role === "user") {
      return m.content;
    }
  }
  return null;
};
