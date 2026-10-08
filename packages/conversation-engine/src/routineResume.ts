import type {
  AttemptRoutineInput,
  ConversationMessage,
  ConversationRoutineClaim,
  ConversationRoutineResumeInput,
  ConversationRoutineRunEffects,
  ConversationRoutineRunner,
  ConversationRoutineSteeringInput,
  ConversationRoutineTurnClaim,
  ConversationTraceStage,
  ProcessTurnResult,
  RenderableTurn,
  RoutineState,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";
import { routineEndingEffects } from "./routineEnding.js";
import {
  buildResolvedSteering,
  knownAnswerCoverage,
  steeringForKnownVerdict,
  withRoutineStepSteering,
} from "./steering.js";
import {
  createInputEvent,
  createProcessTurnResult,
  createResponseEvent,
  createTrace,
  historyGatherStage,
  reportProgress,
  stage,
} from "./traceStages.js";

/**
 * A runner that can only resume renders its reply as it walks, so its claim carries the
 * reply it already generated.
 */
const claimFrom = async (
  runner: ConversationRoutineRunner,
  input: ConversationRoutineResumeInput,
): Promise<ConversationRoutineClaim> => {
  if (runner.claim) {
    return runner.claim(input);
  }
  const { response, yielded, pendingStep, ...effects } = await runner.resume(input);
  if (yielded) {
    return { kind: "yielded", ...(pendingStep ? { pendingStep } : {}) };
  }
  return { kind: "claimed", effects, reply: { render: async () => response } };
};

/**
 * Walks the routine `state` for this turn and claims the turn for it, or returns null when
 * the routine yields the turn. Settling records the turn after its reply exists, in the
 * order a whole resume always did: the directive steering a runner never asked for is
 * matched after the reply, then the input event, the routine state, the response event.
 */
export const claimRoutineResume = async (input: {
  request: AttemptRoutineInput;
  baseTurn: TurnContext;
  state: RoutineState;
  resuming: boolean;
  history: ConversationMessage[];
  activationClarificationStage?: ConversationTraceStage | null;
}): Promise<ConversationRoutineTurnClaim | null> => {
  const { request, baseTurn, state, resuming } = input;
  const turn: TurnContext = {
    ...baseTurn,
    activeRoutineId: state.routineId,
    activeStepId: state.path.at(-1),
  };
  let directiveSteeringStage: ConversationTraceStage | null = null;
  // The activated routine's step prompt never itself emits a `coverage` field, so
  // a coverage-gated directive must not reach it as a condition on one (#1260
  // review round 4, F3). Reduce to the known verdict already on this turn — set
  // by the compose-time sink before it started this routine — the same way the
  // pre-activation clarifier does.
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
      const steering = steeringForKnownVerdict(resolved.steering, knownAnswerCoverage(turn));
      directiveSteeringStage = withRoutineStepSteering(resolved.traceStage, {
        routineId: state.routineId,
        stepId: step.id,
        steering,
      });
      return steering;
    },
  };

  reportProgress(request, "routine");
  const claim = await claimFrom(request.routineRunner!, {
    turn,
    state,
    steeringResolver: routineSteeringResolver,
    activationTurn: !resuming,
  });
  if (claim.kind === "yielded") {
    request.routineYieldSink?.yielded({
      sessionId: request.sessionId,
      ...(request.inputEvent.id ? { inputEventId: request.inputEvent.id } : {}),
      routineId: state.routineId,
      ...(state.executionId ? { executionId: state.executionId } : {}),
      ...(claim.pendingStep ? { pendingStep: claim.pendingStep } : {}),
    });
    return null;
  }
  const ending = routineEndingEffects(state.routineId, claim.effects.terminal);
  const routineExecution = {
    routineId: state.routineId,
    ...(state.executionId ? { executionId: state.executionId } : {}),
  };
  const claimed: ClaimedRoutineTurn = {
    ...input,
    turn,
    effects: claim.effects,
    ending,
    routineExecution,
    directiveSteeringStage: () => directiveSteeringStage,
  };
  return {
    effects: {
      routineExecution,
      ...(claim.effects.terminal ? { terminalKind: claim.effects.terminal.kind } : {}),
      ...(claim.effects.actions ? { actions: claim.effects.actions } : {}),
      ...(claim.effects.awaitingDecision ? { awaitingDecision: claim.effects.awaitingDecision } : {}),
      ...ending,
    },
    reply: claim.reply,
    settle: (response) => settleRoutineTurn(claimed, response),
  };
};

interface ClaimedRoutineTurn {
  request: AttemptRoutineInput;
  state: RoutineState;
  resuming: boolean;
  history: ConversationMessage[];
  activationClarificationStage?: ConversationTraceStage | null;
  turn: TurnContext;
  effects: ConversationRoutineRunEffects;
  ending: ReturnType<typeof routineEndingEffects>;
  routineExecution: NonNullable<ProcessTurnResult["routineExecution"]>;
  /** The step steering the runner resolved while claiming, if it resolved any. */
  directiveSteeringStage: () => ConversationTraceStage | null;
}

const settleRoutineTurn = async (claimed: ClaimedRoutineTurn, response: RenderableTurn): Promise<ProcessTurnResult> => {
  const { request, state, resuming, history, turn, effects: result, ending } = claimed;
  let directiveSteeringStage = claimed.directiveSteeringStage();
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
  if (!request.inputEventAlreadyAppended) {
    await request.stores.appendEvent(inputEvent);
  }
  events.push(inputEvent);

  if (result.nextState) {
    await request.routineStore!.save(result.nextState);
  } else {
    // A normal terminal ending lands by moving onto a terminal step the path never
    // held; a stuck ending (#1384) lands on the chat step already last in `path` — the
    // walk never advanced off it — so appending it again would duplicate that entry.
    const landedStepId = result.trace?.landedStepId;
    const path = landedStepId && landedStepId !== state.path.at(-1)
      ? [...state.path, landedStepId]
      : state.path;
    await request.routineStore!.save({
      ...state,
      path,
      status: "completed",
      metadata: {
        ...(state.metadata ?? {}),
        ...(result.terminal ? { terminalKind: result.terminal.kind, terminalStepId: result.terminal.stepId } : {}),
      },
    });
  }

  const responseEvent = createResponseEvent(request.sessionId, response);
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
      handoff: ending.handoff !== undefined,
      notifiesOperators: ending.operatorNotice !== undefined,
      answerLength: response.answer.length,
    },
    ...(result.trace ? { subTrace: { namespace: "routine", version: 1, payload: result.trace } } : {}),
  });
  const routineTraceStages = claimed.activationClarificationStage
    ? [
        messageStage,
        historyGatherStage(history),
        claimed.activationClarificationStage,
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
    response,
    actions: result.actions,
    ...ending,
    routineExecution: claimed.routineExecution,
    awaitingDecision: result.awaitingDecision,
    trace: createTrace(routineTraceStages),
  });
};
