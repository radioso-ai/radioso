import {
  noopSkillEmitPort,
  type SkillDefinition,
  type SkillExecutorRegistry,
} from "../../skills/public.js";
import {
  readRetrievalResult,
  type RetrievalPipelineInterpretationResult,
  type RetrievalPipelineResult,
  type RetrievalPipelineService,
} from "../../retrieval/public.js";

/**
 * The turn loop's retrieval dispatch step: given an interpreted turn and whether
 * it is a retrieval turn, produce the grounded-answer context. This is the seam
 * that lets the chat path reach retrieval through the skill-invocation port
 * instead of calling the retrieval controller directly.
 */
export interface RetrievalTurnDispatchInput {
  interpreted: RetrievalPipelineInterpretationResult;
  withRetrieval: boolean;
}

export interface RetrievalTurnDispatchPort {
  dispatch(input: RetrievalTurnDispatchInput): Promise<RetrievalPipelineResult>;
}

/**
 * Behavior-preserving default: call the retrieval controller directly. Used when
 * no skill-dispatching port is wired (e.g. preparer unit tests), so existing
 * behavior is unchanged.
 */
export class DirectRetrievalTurnDispatch implements RetrievalTurnDispatchPort {
  constructor(private readonly controller: RetrievalPipelineService) {}

  async dispatch({ interpreted, withRetrieval }: RetrievalTurnDispatchInput): Promise<RetrievalPipelineResult> {
    return withRetrieval
      ? this.controller.runInterpreted(interpreted)
      : this.controller.runWithoutRetrieval(interpreted);
  }
}

/**
 * Dispatches `retrieval.answer` through the skill-invocation port and reads the
 * rich result back from the outcome. Produces the same RetrievalPipelineResult
 * the direct path does (the executor wraps the same controller), so the
 * grounded-answer path is preserved byte-for-byte.
 */
export class SkillRetrievalTurnDispatch implements RetrievalTurnDispatchPort {
  constructor(
    private readonly executorRegistry: SkillExecutorRegistry,
    private readonly skill: SkillDefinition,
  ) {}

  async dispatch({ interpreted, withRetrieval }: RetrievalTurnDispatchInput): Promise<RetrievalPipelineResult> {
    if (!this.skill.execution) {
      throw new Error(`Skill "${this.skill.name}" has no execution descriptor to resolve an executor`);
    }
    const executor = this.executorRegistry.resolve(this.skill.execution);
    if (!executor) {
      throw new Error(`No skill executor registered for "${this.skill.name}"`);
    }

    const result = await executor.dispatch({
      skill: this.skill,
      collected: {},
      context: { interpreted, withRetrieval },
      emit: noopSkillEmitPort,
    });
    if (result.disposition !== "settled") {
      throw new Error(`Skill "${this.skill.name}" returned a ${result.disposition} disposition; the chat turn requires a settled retrieval result`);
    }

    const retrieval = readRetrievalResult(result.outcome);
    if (!retrieval) {
      throw new Error(`Skill "${this.skill.name}" settled without a retrieval result`);
    }
    return retrieval;
  }
}
