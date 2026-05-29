import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
  SkillOutcome,
} from "../../skills/public.js";

import type {
  RetrievalPipelineInterpretationResult,
  RetrievalPipelinePort,
  RetrievalPipelineResult,
} from "./retrievalPipelineService.js";
import type { RetrievalPipelineRequest } from "./retrievalPipelineStages.js";

/** Internal-adapter key the `retrieval.answer` skill declares in its execution descriptor. */
export const RETRIEVAL_ANSWER_ADAPTER = "retrieval_answer";

// The rich RetrievalPipelineResult is not a model-visible answer/output — it is
// loop-internal context the chat turn composes its response from. It therefore
// rides on the outcome's non-model `metadata` channel under a private key, read
// back through the typed helper below so the boundary stays type-safe even
// though the envelope slot is Record<string, unknown>.
const RETRIEVAL_RESULT_KEY = "__retrievalResult";

const embedRetrievalResult = (result: RetrievalPipelineResult): SkillOutcome => ({
  status: "completed",
  metadata: { [RETRIEVAL_RESULT_KEY]: result },
});

/** Extracts the RetrievalPipelineResult a retrieval.answer dispatch settled with, if present. */
export const readRetrievalResult = (outcome: SkillOutcome): RetrievalPipelineResult | null => {
  const value = outcome.metadata?.[RETRIEVAL_RESULT_KEY];
  return value ? (value as RetrievalPipelineResult) : null;
};

interface InterpretedInvocationContext {
  interpreted: RetrievalPipelineInterpretationResult;
  withRetrieval: boolean;
}

const isRequest = (value: unknown): value is RetrievalPipelineRequest =>
  typeof value === "object" && value !== null &&
  typeof (value as RetrievalPipelineRequest).workspaceId === "string" &&
  typeof (value as RetrievalPipelineRequest).query === "string" &&
  Array.isArray((value as RetrievalPipelineRequest).history);

const isInterpreted = (value: unknown): value is InterpretedInvocationContext =>
  typeof value === "object" && value !== null &&
  "interpreted" in value && typeof (value as InterpretedInvocationContext).withRetrieval === "boolean";

/**
 * Dispatches the `retrieval.answer` capability through the skill-invocation port
 * by wrapping the retrieval controller (the fixed/reasoning strategy chooser).
 * Resolution (b) of spec 067/066: the chat turn loop owns answer composition, so
 * this executor returns the rich retrieval *result* as loop-internal context
 * rather than a composed answer.
 *
 * It accepts either a raw `request` (runs the full interpret+execute path) or an
 * already-interpreted result plus a `withRetrieval` flag (the two-phase path the
 * chat loop uses, where interpretation/routing happen in the loop's gather step).
 */
export class RetrievalAnswerSkillExecutor implements SkillExecutorPort {
  constructor(private readonly controller: RetrievalPipelinePort) {}

  async dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    const context = invocation.context ?? {};

    if (isInterpreted(context)) {
      const result = context.withRetrieval
        ? await this.controller.runInterpreted(context.interpreted)
        : await this.controller.runWithoutRetrieval(context.interpreted);
      return { disposition: "settled", outcome: embedRetrievalResult(result) };
    }

    if (isRequest(context.request)) {
      const result = await this.controller.run(context.request);
      return { disposition: "settled", outcome: embedRetrievalResult(result) };
    }

    throw new Error(
      "retrieval.answer dispatch requires a `request` or an `interpreted` result in the invocation context",
    );
  }
}
