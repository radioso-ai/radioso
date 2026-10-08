import type {
  AttemptRoutineInput,
  ClarificationCandidate,
  ConversationMessage,
  ConversationRoutineTurnClaim,
  ConversationTraceStage,
  PendingRenderableTurn,
  ProcessTurnResult,
  RenderableTurn,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { clarificationStage } from "./clarification.js";
import { verifySlotCorrection } from "./slotCorrection.js";
import { buildResolvedSteering, knownAnswerCoverage, steeringForKnownVerdict } from "./steering.js";
import { claimRoutineResume } from "./routineResume.js";
import {
  createInputEvent,
  createProcessTurnResult,
  createResponseEvent,
  createTrace,
  historyGatherStage,
  reportProgress,
  stage,
} from "./traceStages.js";

const routineIdFromClarificationCandidate = (candidate: { payload: unknown }): string | undefined => {
  const payload = candidate.payload;
  if (typeof payload !== "object" || payload === null || !("routineId" in payload)) {
    return undefined;
  }
  return typeof payload.routineId === "string" ? payload.routineId : undefined;
};

/**
 * Carries only the activation boundary that failed. The engine maps this to a
 * safe trace value and must never expose the originating error detail.
 */
export class RoutineActivationFailure extends Error {
  constructor(readonly phase: "selection" | "resume", cause?: unknown) {
    super(`Routine ${phase} failed`, cause === undefined ? undefined : { cause });
    this.name = "RoutineActivationFailure";
  }
}

/**
 * The claim's reply and settle can fail after the claim itself succeeded; they fail the same
 * way the claim does, as the routine resume they are part of.
 */
const failingAsResume = (claim: ConversationRoutineTurnClaim): ConversationRoutineTurnClaim => {
  const stream = claim.reply.stream?.bind(claim.reply);
  const reply: PendingRenderableTurn = {
    render: () => asResumeFailure(() => claim.reply.render()),
    ...(stream ? { stream: () => streamAsResumeFailure(stream()) } : {}),
  };
  return {
    effects: claim.effects,
    reply,
    settle: (response) => asResumeFailure(() => claim.settle(response)),
  };
};

const asResumeFailure = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw new RoutineActivationFailure("resume", error);
  }
};

async function* streamAsResumeFailure(
  stream: AsyncGenerator<string, RenderableTurn>,
): AsyncGenerator<string, RenderableTurn> {
  try {
    return yield* stream;
  } catch (error) {
    throw new RoutineActivationFailure("resume", error);
  }
}

/** A reply generated whole from text a routine port writes; it has no stream. */
const textReply = (write: () => Promise<string>): PendingRenderableTurn => ({
  render: async () => ({ answer: await write() }),
});

const buildSlotCorrectionTurn = async (
  input: AttemptRoutineInput,
  routineId: string,
  response: RenderableTurn,
  correctionStage: { status: ConversationTraceStage["status"]; outputs: Record<string, unknown> },
): Promise<ProcessTurnResult> => {
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

const claimCompletedRoutineCorrection = async (
  input: AttemptRoutineInput,
  baseTurn: TurnContext,
  completedStates: RoutineState[],
): Promise<ConversationRoutineTurnClaim | null> => {
  const { routineSlotCorrection, routineStore } = input;
  if (!routineSlotCorrection || !routineStore) {
    return null;
  }
  const completedState = completedStates[0];
  if (!completedState) {
    return null;
  }
  const candidate = await routineSlotCorrection.detect({ turn: baseTurn, completedState });
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
      return {
        effects: {},
        reply: textReply(() => routineSlotCorrection.rejectInvalid({
          turn: baseTurn,
          routineId: completedState.routineId,
          slotKey: candidate.slotKey,
        })),
        settle: (response) => buildSlotCorrectionTurn(input, completedState.routineId, response, {
          status: "rejected",
          outputs: { routineId: completedState.routineId, slotKey: candidate.slotKey, reason: "invalid_value" },
        }),
      };
    }
    return null;
  }
  return {
    effects: {},
    reply: textReply(() => routineSlotCorrection.confirm({
      turn: baseTurn,
      routineId: completedState.routineId,
      slotKey: verdict.key,
      value: verdict.value,
    })),
    settle: async (response) => {
      await routineStore.save({
        ...completedState,
        variables: { ...completedState.variables, [verdict.key]: verdict.value },
        status: "completed",
      });
      return buildSlotCorrectionTurn(input, completedState.routineId, response, {
        status: "applied",
        outputs: { routineId: completedState.routineId, slotKey: verdict.key },
      });
    },
  };
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
      executionId: completedState.executionId ?? globalThis.crypto.randomUUID(),
      path: [],
      variables: { ...completedState.variables },
      status: "active",
    };
  }
  if (decision.kind === "start_new") {
    return {
      sessionId: input.sessionId,
      routineId: completedState.routineId,
      executionId: globalThis.crypto.randomUUID(),
      path: [],
      variables: {},
      status: "active",
    };
  }
  return null;
};

/**
 * The activator found several routines that could start and asks which one the visitor
 * means. The question is the reply; settling records it as the pending clarification.
 */
const claimActivationClarification = async (
  input: AttemptRoutineInput,
  baseTurn: TurnContext,
  history: ConversationMessage[],
  candidates: ClarificationCandidate[],
): Promise<ConversationRoutineTurnClaim | null> => {
  const { clarifier, clarificationStore } = input;
  if (!clarifier || !clarificationStore) {
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
  return {
    effects: {},
    // A coverage-gated rule renders as a condition on a `coverage` field
    // ("Only when your coverage verdict is one of [...]") that this clarifying
    // question's model is never asked to emit — it commits no verdict of its
    // own. Reduce to the known verdict already on the turn (or none, on the
    // pre-retrieval path where no verdict can exist yet) before rendering.
    reply: textReply(() => clarifier.phraseQuestion({
      candidates,
      turn: {
        ...baseTurn,
        steering: steeringForKnownVerdict(clarifySteering.steering, knownAnswerCoverage(baseTurn)),
      },
    })),
    settle: async (response) => {
      const events = [] as Awaited<ReturnType<typeof createInputEvent>>[];
      const inputEvent = createInputEvent(input);
      if (!input.inputEventAlreadyAppended) {
        await input.stores.appendEvent(inputEvent);
      }
      events.push(inputEvent);
      const responseEvent = createResponseEvent(input.sessionId, response);
      await input.stores.appendEvent(responseEvent);
      events.push(responseEvent);
      await clarificationStore.save({
        sessionId: input.sessionId,
        source: "routine_activation",
        originalQuery: input.inputEvent.content,
        mode: "ask",
        candidates,
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
        routineClarificationRoutineIds: candidates.flatMap((candidate) => {
          const routineId = routineIdFromClarificationCandidate(candidate);
          return routineId ? [routineId] : [];
        }),
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
            decision: { kind: "ask", candidates },
          }),
          clarifySteering.traceStage,
        ]),
      });
    },
  };
};

const claimRoutineWithMode = async (
  input: AttemptRoutineInput,
  mode: "normal" | "activation_only",
): Promise<ConversationRoutineTurnClaim | null> => {
  if (!input.routineStore || !input.routineRunner) {
    return null;
  }
  const active = mode === "normal"
    ? await input.routineStore.loadActive({ sessionId: input.sessionId })
    : null;
  const resuming = !!active && active.status === "active";
  const history = await input.stores.loadHistory({ sessionId: input.sessionId });
  const baseTurn: TurnContext = input.turnContext ?? {
    agent: input.agent,
    sessionId: input.sessionId,
    inputEvent: input.inputEvent,
    history,
    stagedContext: [],
    steering: [],
  };
  let state = resuming ? active : null;
  let activationClarificationStage: ConversationTraceStage | null = null;
  const completedStates = state ? [] : ((await input.routineStore.loadCompleted?.({ sessionId: input.sessionId })) ?? []);
  if (!state) {
    if (mode === "normal") {
      const correction = await claimCompletedRoutineCorrection(input, baseTurn, completedStates);
      if (correction) {
        return correction;
      }
    }
    state = await tryCompletedRoutineReentry(input, baseTurn, completedStates);
  }
  if (!state) {
    if (!input.routineActivator) {
      return null;
    }
    const completedRoutineIds = completedStates.map((completed) => completed.routineId);
    let activation;
    try {
      activation = await input.routineActivator.activate({
        turn: baseTurn,
        ...(input.loopGuardCandidateIds ? { loopGuardCandidateIds: input.loopGuardCandidateIds } : {}),
        ...(completedRoutineIds.length > 0 ? { suppressedRoutineIds: completedRoutineIds } : {}),
        ...(input.suppressNewClarification ? { suppressClarificationAsk: input.suppressNewClarification } : {}),
      });
    } catch (error) {
      throw new RoutineActivationFailure("selection", error);
    }
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
      return claimActivationClarification(input, baseTurn, history, activation.candidates);
    }
    state = {
      sessionId: input.sessionId,
      routineId: activation.routineId,
      executionId: globalThis.crypto.randomUUID(),
      path: [],
      variables: activation.variables ?? {},
      status: "active",
    };
  }

  let claim: ConversationRoutineTurnClaim | null;
  try {
    claim = await claimRoutineResume({
      request: input,
      baseTurn,
      state,
      resuming,
      history,
      activationClarificationStage,
    });
  } catch (error) {
    throw new RoutineActivationFailure("resume", error);
  }
  return claim ? failingAsResume(claim) : null;
};

const attemptRoutineWithMode = async (
  input: AttemptRoutineInput,
  mode: "normal" | "activation_only",
): Promise<ProcessTurnResult | null> => {
  const claim = await claimRoutineWithMode(input, mode);
  return claim ? claim.settle(await claim.reply.render()) : null;
};

/**
 * Full pre-retrieval routine pass: resumes an active routine before selecting a new one.
 * Claims the turn without generating its reply; the holder renders or streams the reply,
 * then settles the claim with it.
 */
export const claimRoutine = async (input: AttemptRoutineInput): Promise<ConversationRoutineTurnClaim | null> =>
  claimRoutineWithMode(input, "normal");

/** {@link claimRoutine} with the reply rendered whole and the turn settled. */
export const attemptRoutine = async (input: AttemptRoutineInput): Promise<ProcessTurnResult | null> =>
  attemptRoutineWithMode(input, "normal");

/**
 * Post-evidence coverage pass: may start or reenter a completed routine, but never
 * consumes an active routine or applies a completed-slot correction.
 */
export const attemptRoutineActivation = async (input: AttemptRoutineInput): Promise<ProcessTurnResult | null> =>
  attemptRoutineWithMode(input, "activation_only");
