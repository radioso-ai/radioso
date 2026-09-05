import type {
  AttemptRoutineInput,
  ConversationMessage,
  ConversationRoutineSteeringInput,
  ConversationTraceStage,
  ProcessTurnResult,
  RoutineState,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";
import { buildResolvedSteering } from "./steering.js";
import {
  createInputEvent,
  createProcessTurnResult,
  createResponseEvent,
  createTrace,
  historyGatherStage,
  reportProgress,
  stage,
} from "./traceStages.js";

export const resumeRoutine = async (input: {
  request: AttemptRoutineInput;
  baseTurn: TurnContext;
  state: RoutineState;
  resuming: boolean;
  history: ConversationMessage[];
  activationClarificationStage?: ConversationTraceStage | null;
}): Promise<ProcessTurnResult | null> => {
  const { request, baseTurn, state, resuming, history } = input;
  const turn: TurnContext = {
    ...baseTurn,
    activeRoutineId: state.routineId,
    activeStepId: state.path.at(-1),
  };
  let directiveSteeringStage: ConversationTraceStage | null = null;
  const routineSteeringResolver = {
    resolve: async ({ step, baseSteering }: ConversationRoutineSteeringInput): Promise<SteeringRule[]> => {
      const resolved = await buildResolvedSteering({
        turn: { ...turn, activeStepId: step.id },
        directives: request.directives,
        directiveMatcher: request.directiveMatcher,
        steeringResolver: request.steeringResolver,
        baseSteering,
        traceKind: "directive_steering",
      });
      directiveSteeringStage = resolved.traceStage;
      return resolved.steering;
    },
  };

  reportProgress(request, "routine");
  const result = await request.routineRunner!.resume({
    turn,
    state,
    steeringResolver: routineSteeringResolver,
    activationTurn: !resuming,
  });
  if (result.yielded) {
    return null;
  }
  if (!directiveSteeringStage) {
    const landedStepId = result.nextState?.path.at(-1) ?? state.path.at(-1);
    const resolved = await buildResolvedSteering({
      turn: { ...turn, activeStepId: landedStepId },
      directives: request.directives,
      directiveMatcher: request.directiveMatcher,
      steeringResolver: request.steeringResolver,
      baseSteering: [],
      traceKind: "directive_steering",
    });
    directiveSteeringStage = resolved.traceStage;
  }

  const events = [] as Awaited<ReturnType<typeof createInputEvent>>[];
  const inputEvent = createInputEvent(request);
  await request.stores.appendEvent(inputEvent);
  events.push(inputEvent);

  if (result.nextState) {
    await request.routineStore!.save(result.nextState);
  } else {
    await request.routineStore!.save({
      ...state,
      path: result.trace?.landedStepId ? [...state.path, result.trace.landedStepId] : state.path,
      status: "completed",
      metadata: {
        ...(state.metadata ?? {}),
        ...(result.terminal ? { terminalKind: result.terminal.kind, terminalStepId: result.terminal.stepId } : {}),
      },
    });
  }

  const responseEvent = createResponseEvent(request.sessionId, result.response);
  await request.stores.appendEvent(responseEvent);
  events.push(responseEvent);

  const messageStage = stage({
    id: "message",
    kind: "message",
    status: "applied",
    outputs: {
      eventId: request.inputEvent.id,
      kind: request.inputEvent.kind,
      contentLength: request.inputEvent.content.length,
      locale: request.inputEvent.locale ?? undefined,
    },
  });
  const routineStage = stage({
    id: `routine:${state.routineId}`,
    kind: resuming ? "routine_resume" : "routine_activate",
    status: "applied",
    outputs: {
      routineId: state.routineId,
      completed: result.nextState === null,
      terminalKind: result.terminal?.kind,
      handoff: result.terminal?.kind === "handoff",
      answerLength: result.response.answer.length,
    },
    ...(result.trace ? { subTrace: { namespace: "routine", version: 1, payload: result.trace } } : {}),
  });
  const routineTraceStages = input.activationClarificationStage
    ? [
        messageStage,
        historyGatherStage(history),
        input.activationClarificationStage,
        routineStage,
        directiveSteeringStage,
      ]
    : [messageStage, historyGatherStage(history), routineStage, directiveSteeringStage];

  return createProcessTurnResult({
    sessionId: request.sessionId,
    events,
    decision: {
      selected: [],
      reason: `${resuming ? "routine_resumed" : "routine_activated"}:${state.routineId}`,
    },
    outcomes: result.outcomes ?? [],
    response: result.response,
    actions: result.actions,
    handoff: result.terminal?.kind === "handoff"
      ? { routineId: state.routineId, stepId: result.terminal.stepId }
      : undefined,
    awaitingDecision: result.awaitingDecision,
    trace: createTrace(routineTraceStages),
  });
};
