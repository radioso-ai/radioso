import type {
  AttemptRoutineInput,
  ConversationMessage,
  ConversationRoutineDecisionResult,
  ConversationTraceStage,
  ProcessTurnResult,
  RenderableTurn,
  RoutineState,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";
import { clarificationStage } from "./clarification.js";
import { verifySlotCorrection } from "./slotCorrection.js";
import { buildResolvedSteering } from "./steering.js";
import { resumeRoutine } from "./routineResume.js";
import {
  createInputEvent,
  createProcessTurnResult,
  createResponseEvent,
  createTrace,
  historyGatherStage,
  reportProgress,
  stage,
} from "./traceStages.js";

const buildSlotCorrectionTurn = async (
  input: AttemptRoutineInput,
  routineId: string,
  answer: string,
  correctionStage: { status: ConversationTraceStage["status"]; outputs: Record<string, unknown> },
): Promise<ProcessTurnResult> => {
  const response: RenderableTurn = { answer };
  const events = [] as Awaited<ReturnType<typeof createInputEvent>>[];
  const inputEvent = createInputEvent(input);
  await input.stores.appendEvent(inputEvent);
  events.push(inputEvent);
  const responseEvent = createResponseEvent(input.sessionId, response);
  await input.stores.appendEvent(responseEvent);
  events.push(responseEvent);
  return createProcessTurnResult({
    sessionId: input.sessionId,
    events,
    decision: { selected: [], reason: "routine_slot_correction" },
    outcomes: [],
    response,
    trace: createTrace([
      stage({
        id: "message",
        kind: "message",
        status: "applied",
        outputs: {
          eventId: input.inputEvent.id,
          kind: input.inputEvent.kind,
          contentLength: input.inputEvent.content.length,
          locale: input.inputEvent.locale ?? undefined,
        },
      }),
      stage({
        id: `routine_slot_correction:${routineId}`,
        kind: "routine_slot_correction",
        status: correctionStage.status,
        outputs: correctionStage.outputs,
      }),
    ]),
  });
};

const tryCompletedRoutineCorrection = async (
  input: AttemptRoutineInput,
  baseTurn: TurnContext,
  completedStates: RoutineState[],
): Promise<ProcessTurnResult | null> => {
  if (!input.routineSlotCorrection || !input.routineStore) {
    return null;
  }
  const completedState = completedStates[0];
  if (!completedState) {
    return null;
  }
  const candidate = await input.routineSlotCorrection.detect({ turn: baseTurn, completedState });
  if (!candidate) {
    return null;
  }
  const verdict = verifySlotCorrection({
    slots: candidate.slots,
    slotKey: candidate.slotKey,
    rawValue: candidate.rawValue,
  });
  if (!verdict.ok) {
    if (verdict.reason === "invalid_value") {
      const answer = await input.routineSlotCorrection.rejectInvalid({
        turn: baseTurn,
        routineId: completedState.routineId,
        slotKey: candidate.slotKey,
      });
      return buildSlotCorrectionTurn(input, completedState.routineId, answer, {
        status: "rejected",
        outputs: { routineId: completedState.routineId, slotKey: candidate.slotKey, reason: "invalid_value" },
      });
    }
    return null;
  }
  const answer = await input.routineSlotCorrection.confirm({
    turn: baseTurn,
    routineId: completedState.routineId,
    slotKey: verdict.key,
    value: verdict.value,
  });
  await input.routineStore.save({
    ...completedState,
    variables: { ...completedState.variables, [verdict.key]: verdict.value },
    status: "completed",
  });
  return buildSlotCorrectionTurn(input, completedState.routineId, answer, {
    status: "applied",
    outputs: { routineId: completedState.routineId, slotKey: verdict.key },
  });
};

const tryCompletedRoutineReentry = async (
  input: AttemptRoutineInput,
  baseTurn: TurnContext,
  completedStates: RoutineState[],
): Promise<RoutineState | null> => {
  if (!input.routineReentryGate) {
    return null;
  }
  const completedState = completedStates[0];
  if (!completedState) {
    return null;
  }
  const decision = await input.routineReentryGate.decide({ turn: baseTurn, completedState });
  if (decision.kind === "resume_existing") {
    return {
      sessionId: input.sessionId,
      routineId: completedState.routineId,
      path: [],
      variables: { ...completedState.variables },
      status: "active",
    };
  }
  if (decision.kind === "start_new") {
    return {
      sessionId: input.sessionId,
      routineId: completedState.routineId,
      path: [],
      variables: {},
      status: "active",
    };
  }
  return null;
};

export const attemptRoutine = async (input: AttemptRoutineInput): Promise<ProcessTurnResult | null> => {
  if (!input.routineStore || !input.routineRunner) {
    return null;
  }
  const active = await input.routineStore.loadActive({ sessionId: input.sessionId });
  const resuming = !!active && active.status === "active";
  const history = await input.stores.loadHistory({ sessionId: input.sessionId });
  const baseTurn: TurnContext = {
    agent: input.agent,
    sessionId: input.sessionId,
    inputEvent: input.inputEvent,
    history,
    stagedContext: [],
    steering: [],
  };
  let state = resuming ? active! : null;
  let activationClarificationStage: ConversationTraceStage | null = null;
  const completedStates = state ? [] : ((await input.routineStore.loadCompleted?.({ sessionId: input.sessionId })) ?? []);
  if (!state) {
    const correction = await tryCompletedRoutineCorrection(input, baseTurn, completedStates);
    if (correction) {
      return correction;
    }
    state = await tryCompletedRoutineReentry(input, baseTurn, completedStates);
  }
  if (!state) {
    if (!input.routineActivator) {
      return null;
    }
    const completedRoutineIds = completedStates.map((completed) => completed.routineId);
    const activation = await input.routineActivator.activate({
      turn: baseTurn,
      ...(input.loopGuardCandidateIds ? { loopGuardCandidateIds: input.loopGuardCandidateIds } : {}),
      ...(completedRoutineIds.length > 0 ? { suppressedRoutineIds: completedRoutineIds } : {}),
      ...(input.suppressNewClarification ? { suppressClarificationAsk: input.suppressNewClarification } : {}),
    });
    if (!activation) {
      return null;
    }
    if (activation.kind === "activate" && activation.decisionMetadata) {
      activationClarificationStage = clarificationStage({
        surface: "routine_activation",
        decision: activation.decisionMetadata.decision,
        consideredCandidates: activation.decisionMetadata.consideredCandidates,
        reason: activation.decisionMetadata.reason,
        margin: activation.decisionMetadata.margin,
      });
    }
    if (activation.kind === "clarify") {
      if (!input.clarifier || !input.clarificationStore) {
        return null;
      }
      const clarifySteering = await buildResolvedSteering({
        turn: baseTurn,
        directives: input.directives,
        directiveMatcher: input.directiveMatcher,
        steeringResolver: input.steeringResolver,
        baseSteering: [],
        traceKind: "directive_steering",
      });
      reportProgress(input, "routine");
      const answer = await input.clarifier.phraseQuestion({
        candidates: activation.candidates,
        turn: { ...baseTurn, steering: clarifySteering.steering },
      });
      const response: RenderableTurn = { answer };
      const events = [] as Awaited<ReturnType<typeof createInputEvent>>[];
      const inputEvent = createInputEvent(input);
      await input.stores.appendEvent(inputEvent);
      events.push(inputEvent);
      const responseEvent = createResponseEvent(input.sessionId, response);
      await input.stores.appendEvent(responseEvent);
      events.push(responseEvent);
      await input.clarificationStore.save({
        sessionId: input.sessionId,
        source: "routine_activation",
        originalQuery: input.inputEvent.content,
        mode: "ask",
        candidates: activation.candidates,
        askedEventId: responseEvent.id,
        status: "pending",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      return createProcessTurnResult({
        sessionId: input.sessionId,
        events,
        decision: { selected: [], reason: "routine_activation_clarification" },
        outcomes: [],
        response,
        trace: createTrace([
          stage({
            id: "message",
            kind: "message",
            status: "applied",
            outputs: {
              eventId: input.inputEvent.id,
              kind: input.inputEvent.kind,
              contentLength: input.inputEvent.content.length,
              locale: input.inputEvent.locale ?? undefined,
            },
          }),
          historyGatherStage(history),
          clarificationStage({
            surface: "routine_activation",
            decision: { kind: "ask", candidates: activation.candidates },
          }),
          clarifySteering.traceStage,
        ]),
      });
    }
    state = {
      sessionId: input.sessionId,
      routineId: activation.routineId,
      path: [],
      variables: activation.variables ?? {},
      status: "active",
    };
  }

  return resumeRoutine({
    request: input,
    baseTurn,
    state,
    resuming,
    history,
    activationClarificationStage,
  });
};
