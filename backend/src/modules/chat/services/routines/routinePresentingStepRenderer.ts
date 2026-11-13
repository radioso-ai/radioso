import type { RoutineGroundedAnswerInput, StagedContext, TurnOutcome } from "@radioso/conversation-contract";

import { setTraceAttributes } from "../../../../shared/observability/tracing/operations.js";
import { AGENT_SKILL_OUTCOME_KIND } from "../agentSkillTurnSkillProvider.js";
import type { PreparedSession } from "../chatSessionPreparer.js";
import type { RecordBlockBinding } from "../replyBlocks/recordBlockBuilder.js";
import { hasToolRecords } from "../replyBlocks/toolRecords.js";
import type { TurnOutcomeRenderer, TurnRenderContext } from "../turnOutcome.js";

/** How a presenting step's turn went: written from its source's records, or without them, and why. Bounded. */
type RoutinePresentOutcome = "presented" | "no_stage" | "source_failed" | "empty";

interface RoutinePresentingStepOptions {
  session: PreparedSession;
  /** Writes a skill's result as the agent's reply; without it, a presenting step gets its own step reply. */
  skillResultRenderer?: TurnOutcomeRenderer;
  accountId?: string;
  responseLanguage?: string | Promise<string | undefined>;
  signal?: AbortSignal;
}

/** What writes a presenting step's reply: the skill-result outcome, its renderer, and the context it renders in. */
export interface RoutinePresentingStepReply {
  outcome: TurnOutcome;
  renderer: TurnOutcomeRenderer;
  context(): Promise<TurnRenderContext>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The result the source step staged this turn, the latest when it ran twice; none on a later turn. */
const sourceStage = (stagedContext: readonly StagedContext[], from: string): StagedContext | undefined =>
  [...stagedContext].reverse().find((staged) => staged.kind === "skill_result" && isRecord(staged.metadata) && staged.metadata.stepId === from);

/** The step's own instruction as rules the reply follows, the way a grounded routine step carries it. */
const withStepSteering = (
  session: PreparedSession,
  steering: RoutineGroundedAnswerInput["steering"],
  responseLanguage: string | undefined,
): PreparedSession => {
  const directiveSteering = session.directiveSteering ?? { rules: [], matches: [], omissions: [] };
  return {
    ...session,
    ...(responseLanguage !== undefined ? { responseLanguage } : {}),
    directiveSteering: { ...directiveSteering, rules: [...directiveSteering.rules, ...steering] },
  };
};

const report = (outcome: RoutinePresentOutcome): void => {
  setTraceAttributes({ "chat.routine.present_outcome": outcome });
};

/**
 * The reply of a routine step that shows a skill step's results (#1763), written host-side the way
 * a grounded step's is, because the step reply has nowhere to put the `present` head. It applies
 * only on the turn the source step ran, while its completed result with records is staged; on any
 * other turn the step's own reply is written (null here). The skill-result renderer writes it from
 * the records: where the cards gate opens, the model picks the records and their fields and the
 * step's binding decides the selection and the stored origin; where the gate is shut (the agent's
 * cards switch off, WhatsApp, voice) the reply lists the records in text.
 */
export const routinePresentingStepReply = (
  options: RoutinePresentingStepOptions,
  input: RoutineGroundedAnswerInput,
): RoutinePresentingStepReply | null => {
  const present = input.step.present;
  const routineId = input.turn.activeRoutineId;
  const renderer = options.skillResultRenderer;
  if (!present || !routineId || !renderer) {
    return null;
  }
  const staged = sourceStage(input.turn.stagedContext, present.from);
  if (!staged) {
    report("no_stage");
    return null;
  }
  if (!isRecord(staged.metadata) || staged.metadata.status !== "completed" || !isRecord(staged.data)) {
    report("source_failed");
    return null;
  }
  if (!hasToolRecords(staged.data)) {
    report("empty");
    return null;
  }
  const skillName = staged.source ?? present.from;
  const outcome: TurnOutcome = {
    kind: AGENT_SKILL_OUTCOME_KIND,
    skillName,
    outcome: { status: "completed", outputs: staged.data },
    stagedContext: [],
    steering: input.steering,
    trace: options.session.turnTrace,
  };
  if (!renderer.supports(outcome)) {
    return null;
  }
  const presentBinding: RecordBlockBinding = {
    selection: present.selection,
    origin: {
      kind: "routine_step",
      skillName,
      routineId,
      stepId: input.step.id,
      ...(present.slot ? { slot: present.slot } : {}),
    },
  };
  report("presented");
  return {
    outcome,
    renderer,
    context: async () => {
      const session = withStepSteering(options.session, input.steering, await options.responseLanguage);
      return {
        session,
        query: session.effectiveQuery ?? session.userMessage.content,
        accountId: options.accountId,
        presentBinding,
        ...(options.signal ? { signal: options.signal } : {}),
      };
    },
  };
};
