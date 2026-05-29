import {
  selectRetrievalStrategy,
  type RetrievalStrategySelection,
} from "../domain/retrievalStrategySelection.js";
import type {
  RetrievalPipelineInterpretationResult,
  RetrievalPipelinePort,
  RetrievalPipelineResult,
} from "./retrievalPipelineService.js";
import type { RetrievalPipelineRequest } from "./retrievalPipelineStages.js";

/**
 * A retrieval execution strategy. Both the deterministic (fixed) pipeline and
 * the agentic (reasoning) pipeline satisfy the same port — sibling strategies
 * that share an output contract, not a base class, and neither privileged as
 * "the pipeline".
 */
export type RetrievalStrategyPipeline = RetrievalPipelinePort;

export interface RetrievalAnswerExecutorDeps {
  /** The fixed (deterministic) strategy. Also owns the shared interpret/non-retrieval paths. */
  readonly fixed: RetrievalStrategyPipeline;
  /**
   * The reasoning (agentic) strategy, or a factory for it. A factory lets the
   * agent runtime stay unconstructed until a turn actually selects reasoning.
   */
  readonly reasoning: RetrievalStrategyPipeline | (() => RetrievalStrategyPipeline);
  /** Optional observer for the selection (telemetry, tracing). */
  readonly onStrategySelected?: (
    selection: RetrievalStrategySelection,
    context: { workspaceId: string },
  ) => void;
}

/**
 * The retrieval controller — the locus of control for *how* a grounded answer
 * is produced. It selects an execution strategy per turn and dispatches to it.
 *
 * Interpretation (intent, rewrite, continuity) and the non-retrieval path are
 * strategy-independent, so they delegate to the fixed strategy. Only
 * `runInterpreted` branches: it selects `fixed` vs `reasoning` from the
 * workspace strategy preference (an open axis owned in settings — NOT a
 * `pipelineMode` mode field) and dispatches.
 *
 * It implements the same surface its strategies do so existing retrieval
 * consumers are unchanged; lifting consumers onto a turn/answer port (so a
 * skill invocation can return deferred results) is the spine work in #465.
 */
export class RetrievalAnswerExecutor implements RetrievalPipelinePort {
  private reasoningInstance: RetrievalStrategyPipeline | null = null;

  constructor(private readonly deps: RetrievalAnswerExecutorDeps) {}

  async run(input: RetrievalPipelineRequest): Promise<RetrievalPipelineResult> {
    return this.runInterpreted(await this.interpret(input));
  }

  async interpret(input: RetrievalPipelineRequest): Promise<RetrievalPipelineInterpretationResult> {
    return this.deps.fixed.interpret(input);
  }

  async runWithoutRetrieval(
    input: RetrievalPipelineInterpretationResult,
  ): Promise<RetrievalPipelineResult> {
    return this.deps.fixed.runWithoutRetrieval(input);
  }

  async runInterpreted(
    input: RetrievalPipelineInterpretationResult,
  ): Promise<RetrievalPipelineResult> {
    const selection = selectRetrievalStrategy({
      workspacePreference: input.context.result.settings.retrievalStrategy,
    });
    this.deps.onStrategySelected?.(selection, { workspaceId: input.request.workspaceId });

    const pipeline = selection.strategy === "reasoning" ? this.resolveReasoning() : this.deps.fixed;
    return pipeline.runInterpreted(input);
  }

  private resolveReasoning(): RetrievalStrategyPipeline {
    if (!this.reasoningInstance) {
      this.reasoningInstance =
        typeof this.deps.reasoning === "function" ? this.deps.reasoning() : this.deps.reasoning;
    }
    return this.reasoningInstance;
  }
}
