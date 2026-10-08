import type {
  ConversationTrace,
  RoutineActionRequest,
  RoutineTurnEffects,
} from "@radioso/conversation-contract";

/**
 * How a claimed routine turn's reply reaches the visitor. `stream`: shown as the model writes
 * it, then persisted with the turn. `whole`: the turn is persisted first, then the finished
 * reply is shown.
 */
type RoutineReplyDelivery = "stream" | "whole";

/** The durable effects a routine ending adds to a turn, as `routineEndingEffectsForTurn` reports them. */
interface RoutineTurnEndingEffects {
  ownershipHandoff: object | null;
  actions?: readonly RoutineActionRequest[];
}

const ROUTINE_TURN_STAGE_KINDS = new Set(["routine_activate", "routine_resume"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Decides how a claimed routine turn's reply is delivered, from what the claim says the turn
 * does. A turn that does something durable — runs a skill (which may already have sent an
 * email or called a webhook), queues an action (a completion export, an approval request, an
 * operator notice), parks at a decision gate, hands the conversation to a person, or ends the
 * routine at all — is persisted before its reply is shown, so the visitor never reads "sent"
 * for something the conversation has not recorded. Any other turn only moves the routine to
 * its next step, so its reply streams; if persisting it fails afterwards, the routine is still
 * on the step it was on and asks again next turn.
 */
export const routineReplyDelivery = (turn: {
  effects: RoutineTurnEffects;
  ending: RoutineTurnEndingEffects;
  replyStreams: boolean;
}): RoutineReplyDelivery => {
  const { effects, ending } = turn;
  const durable = effects.terminalKind !== undefined
    || effects.awaitingDecision !== undefined
    || effects.handoff !== undefined
    || (effects.actions?.length ?? 0) > 0
    || (effects.skillsWithExternalEffects?.length ?? 0) > 0
    || Boolean(ending.ownershipHandoff)
    || (ending.actions?.length ?? 0) > 0;
  return turn.replyStreams && !durable ? "stream" : "whole";
};

/** Records on the turn's routine stage how its reply was delivered. */
export const withRoutineReplyDelivery = (
  trace: ConversationTrace | undefined,
  delivery: RoutineReplyDelivery,
): ConversationTrace | undefined =>
  trace && {
    ...trace,
    stages: trace.stages.map((stage) =>
      ROUTINE_TURN_STAGE_KINDS.has(stage.kind)
        ? { ...stage, outputs: { ...stage.outputs, replyDelivery: delivery } }
        : stage),
  };

/** The routine a turn ran and the step its reply was written for, as the turn's routine stage reports them. */
export const landedRoutineStep = (
  trace: ConversationTrace | undefined,
): { routineId?: string; stepId?: string } => {
  const stage = trace?.stages.find((candidate) => ROUTINE_TURN_STAGE_KINDS.has(candidate.kind));
  const routineId = stage?.outputs?.routineId;
  const payload = stage?.subTrace?.namespace === "routine" ? stage.subTrace.payload : undefined;
  const stepId = isRecord(payload) ? payload.landedStepId : undefined;
  return {
    ...(typeof routineId === "string" ? { routineId } : {}),
    ...(typeof stepId === "string" ? { stepId } : {}),
  };
};
