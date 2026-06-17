import type {
  ConversationRoutineDecisionResult,
  ConversationRoutineRunner,
  ConversationRoutineSteeringResolver,
  RoutineDecisionInput,
  RoutineState,
  RoutineStep,
  SuspendedRoutineReader,
  TurnContext,
} from "@radioso/conversation-contract";

type RoutineStepLookup = {
  getCurrentStep(state: RoutineState): RoutineStep | null;
};

const inertResult = (): ConversationRoutineDecisionResult => ({
  resumed: false,
  response: { answer: "" },
  nextState: null,
});

const canLookupStep = (runner: ConversationRoutineRunner): runner is ConversationRoutineRunner & RoutineStepLookup =>
  typeof (runner as Partial<RoutineStepLookup>).getCurrentStep === "function";

export const resumeAwaitingDecision = async (input: {
  suspendedReader: SuspendedRoutineReader;
  routineRunner: ConversationRoutineRunner;
  turn: TurnContext;
  decision: RoutineDecisionInput;
  steeringResolver?: ConversationRoutineSteeringResolver;
}): Promise<ConversationRoutineDecisionResult> => {
  const state = await input.suspendedReader.loadSuspended({ handle: input.decision.handle });
  if (!state || state.status !== "suspended" || !canLookupStep(input.routineRunner)) {
    return inertResult();
  }

  const step = input.routineRunner.getCurrentStep(state);
  if (!step || step.kind !== "await" || !step.decision) {
    return inertResult();
  }

  if (!step.decision.options.some((option) => option.id === input.decision.optionId)) {
    return inertResult();
  }

  const resumedState: RoutineState = {
    ...state,
    status: "active",
    variables: {
      ...state.variables,
      [step.decision.captureKey]: {
        id: input.decision.optionId,
        ...(input.decision.payload !== undefined ? { payload: input.decision.payload } : {}),
      },
    },
  };
  const result = await input.routineRunner.resume({
    turn: input.turn,
    state: resumedState,
    ...(input.steeringResolver ? { steeringResolver: input.steeringResolver } : {}),
  });
  return { ...result, resumed: true };
};
