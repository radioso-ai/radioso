import {
  noopSkillEmitPort,
  type SkillDefinition,
  type SkillExecutorRegistry,
} from "../../skills/public.js";
import type { CapabilityPolicy } from "../../../shared/domain/capabilityPolicy.js";
import {
  readRetrievalResult,
  type ActivityStage,
  type ActivityTrace,
  type RetrievalPipelineInterpretationResult,
  type RetrievalPipelineRequest,
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
 * The chat turn's whole retrieval surface: interpret (gather) and dispatch
 * (execute). The preparer depends on this narrow port instead of the retrieval
 * controller, so `ChatService` carries no reference to `RetrievalPipelineService`
 * (066 SC-002). The route decision between interpret and dispatch stays in the
 * preparer (chat-owned turn intent).
 */
export interface RetrievalTurnPort {
  interpret(input: RetrievalPipelineRequest): Promise<RetrievalPipelineInterpretationResult>;
  dispatch(input: RetrievalTurnDispatchInput): Promise<RetrievalPipelineResult>;
}

/**
 * Assembles a RetrievalTurnPort from the retrieval controller (for interpret)
 * and an execution-dispatch port (for dispatch). Defaults the dispatch to the
 * direct controller path so test/default construction is behavior-preserving;
 * composition passes {@link SkillRetrievalTurnDispatch} to route execution
 * through the skill-invocation port.
 */
export class RetrievalTurnController implements RetrievalTurnPort {
  private readonly executionDispatch: RetrievalTurnDispatchPort;

  constructor(
    private readonly controller: RetrievalPipelineService,
    executionDispatch?: RetrievalTurnDispatchPort,
  ) {
    this.executionDispatch = executionDispatch ?? new DirectRetrievalTurnDispatch(controller);
  }

  interpret(input: RetrievalPipelineRequest): Promise<RetrievalPipelineInterpretationResult> {
    return this.controller.interpret(input);
  }

  dispatch(input: RetrievalTurnDispatchInput): Promise<RetrievalPipelineResult> {
    return this.executionDispatch.dispatch(input);
  }
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
    private readonly capabilityPolicy: CapabilityPolicy,
  ) {}

  async dispatch({ interpreted, withRetrieval }: RetrievalTurnDispatchInput): Promise<RetrievalPipelineResult> {
    if (!this.skill.execution) {
      throw new Error(`Skill "${this.skill.name}" has no execution descriptor to resolve an executor`);
    }
    const executor = this.executorRegistry.resolve(this.skill.execution);
    if (!executor) {
      throw new Error(`No skill executor registered for "${this.skill.name}"`);
    }

    // 066 FR-008: skill dispatch must honor the per-agent capability model. If
    // the agent is not authorized for the skill, do not retrieve — degrade to a
    // non-grounded answer (the spec's "responds without it"). Capabilities only
    // gate retrieval; a non-retrieval turn needs no authorization.
    const capabilityDenied = withRetrieval
      ? await this.firstDeniedCapability(interpreted.request.workspaceId)
      : null;
    const effectiveWithRetrieval = withRetrieval && !capabilityDenied;

    const result = await executor.dispatch({
      skill: this.skill,
      collected: {},
      context: { interpreted, withRetrieval: effectiveWithRetrieval },
      emit: noopSkillEmitPort,
    });
    if (result.disposition !== "settled") {
      throw new Error(`Skill "${this.skill.name}" returned a ${result.disposition} disposition; the chat turn requires a settled retrieval result`);
    }

    const retrieval = readRetrievalResult(result.outcome);
    if (!retrieval) {
      throw new Error(`Skill "${this.skill.name}" settled without a retrieval result`);
    }

    // 066 FR-015: record the dispatch in the turn trace so the spine is visible
    // and skill outcomes are distinguishable from raw pipeline runs.
    return {
      ...retrieval,
      trace: appendSkillDispatchStage(retrieval.trace, {
        skillName: this.skill.name,
        disposition: result.disposition,
        outcomeStatus: result.outcome.status,
        withRetrieval: effectiveWithRetrieval,
        capabilityDenied: capabilityDenied ?? undefined,
      }),
    };
  }

  private async firstDeniedCapability(workspaceId: string): Promise<string | null> {
    for (const capability of this.skill.requiredCapabilities ?? []) {
      const decision = await this.capabilityPolicy.can({ capability, workspaceId });
      if (!decision.allowed) {
        return decision.reason ?? "capability_denied";
      }
    }
    return null;
  }
}

const appendSkillDispatchStage = (
  trace: ActivityTrace,
  info: {
    skillName: string;
    disposition: string;
    outcomeStatus: string;
    withRetrieval: boolean;
    capabilityDenied?: string;
  },
): ActivityTrace => {
  const previousStageId = trace.stages.at(-1)?.stageId;
  const stage: ActivityStage = {
    stageId: "skill_dispatch",
    kind: "skill_dispatch",
    label: "Skill dispatch",
    status: info.capabilityDenied ? "fallback" : "applied",
    startedAt: new Date().toISOString(),
    outputs: {
      skillName: info.skillName,
      disposition: info.disposition,
      outcomeStatus: info.outcomeStatus,
      withRetrieval: info.withRetrieval,
      ...(info.capabilityDenied ? { capabilityDenied: info.capabilityDenied } : {}),
    },
  };
  return {
    ...trace,
    stages: [...trace.stages, stage],
    links: previousStageId
      ? [...trace.links, { fromStageId: previousStageId, toStageId: stage.stageId, kind: "sequence" as const }]
      : trace.links,
  };
};
