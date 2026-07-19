import type {
  AttemptRoutineInput,
  ConversationEngine,
  ConversationEvent,
  ConversationRoutineSteeringInput,
  ConversationTrace,
  ConversationTraceStage,
  ConversationTurnInterpretation,
  Directive,
  DirectiveMatch,
  ProcessTurnInput,
  ProcessTurnResult,
  ProcessTurnStreamEvent,
  ProcessTurnStreamInput,
  RenderableTurn,
  ResumeAwaitingDecisionInput,
  ConversationRoutineDecisionResult,
  RoutineActionRequest,
  RoutineState,
  RoutineAwaitingDecision,
  SelectionDecision,
  SkillDefinition,
  SkillTransientGuidance,
  StagedContext,
  SteeringResolver,
  SteeringRule,
  TurnContext,
  TurnOutcome,
} from "@radioso/conversation-contract";
import { resumeAwaitingDecision } from "./awaitingDecision.js";
import { verifySlotCorrection } from "./slotCorrection.js";
import { clarificationStage } from "./clarification.js";

const nowIso = (): string => new Date().toISOString();

const stage = (input: Omit<ConversationTraceStage, "startedAt" | "completedAt">): ConversationTraceStage => {
  const timestamp = nowIso();
  return {
    ...input,
    startedAt: timestamp,
    completedAt: timestamp,
  };
};

const timedStage = (
  startedAtMs: number,
  completedAtMs: number,
  input: Omit<ConversationTraceStage, "startedAt" | "completedAt">,
): ConversationTraceStage => ({
  ...input,
  startedAt: new Date(startedAtMs).toISOString(),
  completedAt: new Date(completedAtMs).toISOString(),
});

const HISTORY_TAIL_LIMIT = 12;

const summarizeDirectiveMatch = (match: DirectiveMatch): Record<string, unknown> => ({
  // Directive copy is authored config (not user/assistant content), so keeping
  // it in the trace is safe and lets the UI render the matched rules in full.
  id: match.directive.id,
  name: match.directive.name,
  action: match.directive.action,
  description: match.directive.description,
  priority: match.directive.priority,
  condition: match.directive.condition.kind === "always"
    ? "always"
    : match.directive.condition.description,
  selectionMode: match.selectionMode,
  selectionReason: match.selectionReason,
  selectionConfidence: match.selectionConfidence,
});

/**
 * Conversation text (user input, prior turns, assistant answer) never goes
 * into the trace — the trace lands in audit/debug metadata, and CLAUDE.md
 * forbids raw prompts/completions there. The trace only records structural
 * references (event/message IDs, role, length, status); the dashboard joins
 * back to the already-authorized message records to show the actual text.
 */
const summarizeOutcomeForCompose = (outcome: TurnOutcome): Record<string, unknown> => ({
  skillName: outcome.skillName,
  status: outcome.outcome.status,
  errorCode: outcome.outcome.error?.code,
  errorMessage: outcome.outcome.error?.message,
  answerLength: outcome.outcome.answer?.length ?? 0,
});

const composeOutputsFor = (
  response: RenderableTurn,
  outcomes: TurnOutcome[],
  options: { streamed: boolean },
): Record<string, unknown> => ({
  // Length only — the assistant message itself is persisted on the chat
  // message record and is read back from there by authorized callers.
  answerLength: response.answer.length,
  citationCount: Array.isArray(response.citations) ? response.citations.length : 0,
  suggestionCount: Array.isArray(response.suggestions) ? response.suggestions.length : 0,
  outcomeCount: outcomes.length,
  streamed: options.streamed,
  outcomes: outcomes.map(summarizeOutcomeForCompose),
});

const directiveMatchToSteering = (match: DirectiveMatch): SteeringRule => ({
  action: match.directive.action,
  condition: match.directive.condition.kind === "contextual"
    ? match.directive.condition.description
    : undefined,
  priority: match.directive.priority,
  description: match.directive.description,
  source: "directive",
  lifespan: "response",
});

export const isDirectiveEligibleForTurn = (directive: Directive, turnContext: TurnContext): boolean => {
  for (const tag of directive.tags ?? []) {
    if (tag.startsWith("routine:")) {
      const routineId = tag.slice("routine:".length);
      if (!routineId || turnContext.activeRoutineId !== routineId) {
        return false;
      }
      continue;
    }

    if (tag.startsWith("step:")) {
      const [routineId, stepId, extra] = tag.slice("step:".length).split(":");
      if (
        extra !== undefined ||
        !routineId ||
        !stepId ||
        turnContext.activeRoutineId !== routineId ||
        turnContext.activeStepId !== stepId
      ) {
        return false;
      }
    }
  }

  return true;
};

export class DefaultSteeringResolver implements SteeringResolver {
  resolve(rules: SteeringRule[], _ctx: { turnContext: TurnContext }): SteeringRule[] {
    const indexed = rules.map((rule, index) => ({ rule, index }));
    const base = indexed.filter(({ rule }) => rule.source !== "directive");
    const directives = indexed
      .filter(({ rule }) => rule.source === "directive")
      .sort((a, b) => {
        const priorityDelta = (b.rule.priority ?? 0) - (a.rule.priority ?? 0);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return a.index - b.index;
      });

    const seen = new Set<string>();
    const resolved: SteeringRule[] = [];
    for (const { rule } of [...base, ...directives]) {
      const key = `${rule.action}\u0000${rule.condition ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      resolved.push(rule);
    }
    return resolved;
  }
}

const defaultSteeringResolver = new DefaultSteeringResolver();

const buildDirectiveTraceStage = (input: {
  id: string;
  kind: string;
  matches: DirectiveMatch[];
  candidateCount: number;
  scopeFilteredCount?: number;
  startedAtMs: number;
  completedAtMs: number;
}): ConversationTraceStage => timedStage(input.startedAtMs, input.completedAtMs, {
  id: input.id,
  kind: input.kind,
  status: input.matches.length > 0 ? "applied" : "skipped",
  outputs: {
    matchCount: input.matches.length,
    // Both the selection-time match stage and the routine-turn steering stage
    // carry the full directive summary, so the debug flow renders the mixed-in
    // directives identically on routine and normal turns. Directive copy is
    // authored config (not user/assistant content), so it is safe in the trace.
    directives: input.matches.map(summarizeDirectiveMatch),
    candidateCount: input.candidateCount,
    ...(input.scopeFilteredCount !== undefined ? { scopeFilteredCount: input.scopeFilteredCount } : {}),
  },
});

const buildResolvedSteering = async (input: {
  turn: TurnContext;
  directives?: ProcessTurnInput["directives"];
  directiveMatcher?: ProcessTurnInput["directiveMatcher"];
  steeringResolver?: SteeringResolver;
  baseSteering?: SteeringRule[];
  traceKind?: string;
}): Promise<{ steering: SteeringRule[]; directiveMatches: DirectiveMatch[]; traceStage: ConversationTraceStage }> => {
  const startedAtMs = Date.now();
  const directives = input.directives ?? [];
  const eligibleDirectives = directives.filter((directive) => isDirectiveEligibleForTurn(directive, input.turn));
  const directiveMatches = input.directiveMatcher
    ? await input.directiveMatcher.match({ turn: input.turn, directives: eligibleDirectives })
    : [];
  const directiveSteering = directiveMatches.map(directiveMatchToSteering);
  const combined = [...(input.baseSteering ?? []), ...directiveSteering];
  const steering = (input.steeringResolver ?? defaultSteeringResolver).resolve(combined, {
    turnContext: input.turn,
  });
  const completedAtMs = Date.now();

  return {
    steering,
    directiveMatches,
    traceStage: buildDirectiveTraceStage({
      id: input.traceKind === "directive_steering" ? "directive_steering" : "directives",
      kind: input.traceKind ?? "directive_match",
      matches: directiveMatches,
      candidateCount: eligibleDirectives.length,
      scopeFilteredCount: directives.length - eligibleDirectives.length,
      startedAtMs,
      completedAtMs,
    }),
  };
};

const guidanceToSteering = (guidance: SkillTransientGuidance, fallbackPriority?: number): SteeringRule => ({
  ...guidance,
  priority: guidance.priority ?? fallbackPriority,
  source: "skill",
  lifespan: "response",
});

const createTrace = (stages: ConversationTraceStage[]): ConversationTrace => {
  const startedAt = stages[0]?.startedAt ?? nowIso();
  return {
    traceId: `conversation-turn-${startedAt}`,
    startedAt,
    completedAt: stages.at(-1)?.completedAt ?? startedAt,
    stages,
  };
};

const mergeStagedContext = (outcomes: TurnOutcome[]): StagedContext[] =>
  outcomes.flatMap((outcome) => outcome.stagedContext);

const findSkill = (skills: SkillDefinition[], name: string): SkillDefinition | null =>
  skills.find((skill) => skill.name === name) ?? null;

const missingSkillOutcome = (skillName: string, steering: SteeringRule[]): TurnOutcome => ({
  kind: "generic",
  skillName,
  outcome: {
    status: "failed",
    error: {
      code: "skill_not_found",
      message: `Selected skill "${skillName}" is not registered.`,
      retryable: false,
    },
  },
  stagedContext: [],
  steering,
  trace: createTrace([
    stage({
      id: `dispatch:${skillName}`,
      kind: "skill_dispatch",
      status: "failed",
      outputs: { errorCode: "skill_not_found" },
    }),
  ]),
});

interface PreparedTurnRun {
  stages: ConversationTraceStage[];
  events: ConversationEvent[];
  decision: SelectionDecision;
  outcomes: TurnOutcome[];
  composeTurn: TurnContext;
}

const createInputEvent = (input: AttemptRoutineInput): ConversationEvent => ({
  id: input.inputEvent.id,
  sessionId: input.sessionId,
  kind: input.inputEvent.kind,
  role: "user",
  content: input.inputEvent.content,
  metadata: input.inputEvent.metadata,
  createdAt: nowIso(),
});

const createResponseEvent = (sessionId: string, response: RenderableTurn): ConversationEvent => ({
  id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  sessionId,
  kind: "assistant.response",
  role: "assistant",
  content: response.answer,
  metadata: response.metadata,
  createdAt: nowIso(),
});

const summarizeFraming = (framing: ConversationTurnInterpretation["framing"]): Record<string, unknown> | undefined => {
  if (!framing) {
    return undefined;
  }
  return {
    ...(typeof framing.isIdentityQuestion === "boolean"
      ? { isIdentityQuestion: framing.isIdentityQuestion }
      : {}),
    ...(typeof framing.intentTopic === "string" ? { hasIntentTopic: framing.intentTopic.length > 0 } : {}),
    ...(typeof framing.inScopeRequest === "string" ? { hasInScopeRequest: framing.inScopeRequest.length > 0 } : {}),
    ...(typeof framing.outsideScopeRequest === "string"
      ? { hasOutsideScopeRequest: framing.outsideScopeRequest.length > 0 }
      : {}),
  };
};

const summarizeRewriteProposal = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const proposal = value as Record<string, unknown>;
  return {
    ...(typeof proposal.queryShape === "string" ? { queryShape: proposal.queryShape } : {}),
    ...(typeof proposal.temporalQueryMode === "string" ? { temporalQueryMode: proposal.temporalQueryMode } : {}),
    ...(typeof proposal.turnKind === "string" ? { turnKind: proposal.turnKind } : {}),
    ...(typeof proposal.unresolved === "boolean" ? { unresolved: proposal.unresolved } : {}),
    ...(typeof proposal.confidence === "number" ? { confidence: proposal.confidence } : {}),
    ...(Array.isArray(proposal.retrievalSubqueries)
      ? { retrievalSubqueryCount: proposal.retrievalSubqueries.length }
      : {}),
  };
};

const summarizeInterpretationMetadata = (
  metadata: ConversationTurnInterpretation["metadata"],
): Record<string, unknown> | undefined => {
  if (!metadata) {
    return undefined;
  }
  const rewriteProposal = summarizeRewriteProposal(metadata.rewriteProposal);
  return {
    ...(rewriteProposal ? { rewriteProposal } : {}),
  };
};

const summarizeInterpretation = (interpretation: ConversationTurnInterpretation): Record<string, unknown> => ({
  route: interpretation.route,
  framing: summarizeFraming(interpretation.framing),
  metadata: summarizeInterpretationMetadata(interpretation.metadata),
});

const createProcessTurnResult = (input: {
  sessionId: string;
  events: ConversationEvent[];
  decision: SelectionDecision;
  outcomes: TurnOutcome[];
  response: RenderableTurn;
  trace: ConversationTrace;
  actions?: RoutineActionRequest[];
  handoff?: { routineId: string; stepId: string };
  awaitingDecision?: RoutineAwaitingDecision;
}): ProcessTurnResult => ({
  sessionId: input.sessionId,
  events: input.events,
  decision: input.decision,
  outcomes: input.outcomes,
  response: input.response,
  trace: input.trace,
  ...(input.actions && input.actions.length > 0 ? { actions: input.actions } : {}),
  ...(input.handoff ? { handoff: input.handoff } : {}),
  ...(input.awaitingDecision ? { awaitingDecision: input.awaitingDecision } : {}),
});

export class DefaultConversationEngine implements ConversationEngine {
  private async prepareTurn(input: ProcessTurnInput | ProcessTurnStreamInput): Promise<PreparedTurnRun> {
    const stages: ConversationTraceStage[] = [];
    const events: ConversationEvent[] = [];
    const history = await input.stores.loadHistory({ sessionId: input.sessionId });
    const inputEvent = createInputEvent(input);
    await input.stores.appendEvent(inputEvent);
    events.push(inputEvent);

    const baseTurn: TurnContext = {
      agent: input.agent,
      sessionId: input.sessionId,
      inputEvent: input.inputEvent,
      history,
      stagedContext: [],
      steering: [],
    };
    // Record a structural reference to the input event so the debug UI can
    // resolve the actual text from the chat message record. The content itself
    // never lands in the trace (audit/debug surface).
    stages.push(stage({
      id: "message",
      kind: "message",
      status: "applied",
      outputs: {
        eventId: input.inputEvent.id,
        kind: input.inputEvent.kind,
        contentLength: input.inputEvent.content.length,
        locale: input.inputEvent.locale ?? undefined,
      },
    }));

    // Tail of the loaded history as structural references — role/id/length only,
    // no message text. The UI resolves text from the conversation's authorized
    // message list when rendering the gather detail.
    const historyRefs = history.slice(-HISTORY_TAIL_LIMIT).map((entry, index, slice) => ({
      index: history.length - slice.length + index,
      role: entry.role,
      messageId: entry.id,
      contentLength: entry.content?.length ?? 0,
      createdAt: entry.createdAt,
    }));
    stages.push(stage({
      id: "gather",
      kind: "gather",
      status: "applied",
      outputs: {
        historyCount: history.length,
        history: historyRefs,
      },
    }));

    const interpretationStartedAt = Date.now();
    const interpretation = input.turnInterpreter
      ? await input.turnInterpreter.interpret({ turn: baseTurn })
      : null;
    const interpretationCompletedAt = Date.now();
    if (interpretation) {
      stages.push(timedStage(interpretationStartedAt, interpretationCompletedAt, {
        id: "turn_interpretation",
        kind: "turn_interpretation",
        status: "applied",
        outputs: summarizeInterpretation(interpretation),
      }));
    }

    const interpretedTurn: TurnContext = interpretation
      ? {
          ...baseTurn,
          metadata: {
            ...(baseTurn.metadata ?? {}),
            turnInterpretation: interpretation,
            turnRoute: interpretation.route,
          },
        }
      : baseTurn;

    const resolveDirectives = () => buildResolvedSteering({
      turn: interpretedTurn,
      directives: input.directives,
      directiveMatcher: input.directiveMatcher,
      steeringResolver: input.steeringResolver,
    });
    const resolved = await resolveDirectives();
    const shouldRunRetrieval = Boolean(input.retrievalWork && interpretation?.route === "retrieval");
    const retrievalStartedAt = Date.now();
    const retrievalResult = shouldRunRetrieval
      ? await input.retrievalWork!.run({ turn: interpretedTurn, interpretation: interpretation! })
      : null;
    const retrievalCompletedAt = Date.now();
    if (input.retrievalWork && interpretation) {
      stages.push(timedStage(retrievalStartedAt, retrievalCompletedAt, {
        id: "retrieval_fanout",
        kind: "retrieval_fanout",
        status: shouldRunRetrieval ? "applied" : "skipped",
        outputs: {
          route: interpretation.route,
          stagedContextCount: retrievalResult?.stagedContext?.length ?? 0,
          steeringCount: retrievalResult?.steering?.length ?? 0,
          hasTrace: Boolean(retrievalResult?.trace || retrievalResult?.subTrace),
        },
        ...(retrievalResult?.subTrace ? { subTrace: retrievalResult.subTrace } : {}),
      }));
    }
    const directiveMatches = resolved.directiveMatches;
    const directiveSteering = resolved.steering;
    stages.push(resolved.traceStage);

    const selectedTurn: TurnContext = {
      ...interpretedTurn,
      stagedContext: retrievalResult?.stagedContext ?? [],
      steering: [...directiveSteering, ...(retrievalResult?.steering ?? [])],
    };
    const selectionStartedAt = Date.now();
    const decision = await input.selector.select({
      turn: selectedTurn,
      skills: input.skills,
      directives: directiveMatches,
    });
    const selectionCompletedAt = Date.now();
    stages.push(timedStage(selectionStartedAt, selectionCompletedAt, {
      id: "selection",
      kind: "skill_selection",
      status: decision.selected.length > 0 ? "applied" : "skipped",
      outputs: {
        selectedSkills: decision.selected.map((selected) => selected.skillName),
        reason: decision.reason,
        // The full candidate pool the selector chose from (every skill it
        // looked at), so the user can see what was *not* selected.
        candidates: input.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          selected: decision.selected.some((picked) => picked.skillName === skill.name),
        })),
        // Per-candidate rationale when the selector recorded it.
        considered: decision.considered,
      },
    }));

    const outcomes: TurnOutcome[] = [];
    let mergedSteering = [...selectedTurn.steering];
    for (const selected of decision.selected) {
      const skill = findSkill(input.skills, selected.skillName);
      if (!skill) {
        const failed = missingSkillOutcome(selected.skillName, mergedSteering);
        outcomes.push(failed);
        stages.push(...failed.trace.stages);
        continue;
      }

      const turnForSkill: TurnContext = {
        ...selectedTurn,
        stagedContext: [...selectedTurn.stagedContext, ...mergeStagedContext(outcomes)],
        steering: mergedSteering,
      };
      const dispatchStartedAt = Date.now();
      const outcome = await input.dispatcher.dispatch({
        skill,
        turn: turnForSkill,
        selected,
      });
      const dispatchCompletedAt = Date.now();
      const skillGuidance = (outcome.outcome.guidance ?? []).map((guidance) =>
        guidanceToSteering(guidance, outcome.outcome.control?.lifespan === "session" ? 100 : undefined)
      );
      mergedSteering = [...mergedSteering, ...skillGuidance];
      outcomes.push({
        ...outcome,
        steering: [...outcome.steering, ...skillGuidance],
      });
      stages.push(timedStage(dispatchStartedAt, dispatchCompletedAt, {
        id: `dispatch:${selected.skillName}`,
        kind: "skill_dispatch",
        status: outcome.outcome.status === "completed" ? "applied" : "fallback",
        outputs: {
          skillName: selected.skillName,
          outcomeStatus: outcome.outcome.status,
          guidanceCount: skillGuidance.length,
        },
        // A capability's domain trace rides through opaquely; the engine never inspects it.
        ...(outcome.subTrace ? { subTrace: outcome.subTrace } : {}),
      }));
    }

    const composeTurn: TurnContext = {
      ...selectedTurn,
      stagedContext: [...selectedTurn.stagedContext, ...mergeStagedContext(outcomes)],
      steering: mergedSteering,
    };
    return {
      stages,
      events,
      decision: {
        ...decision,
        steeringConsidered: mergedSteering,
      },
      outcomes,
      composeTurn,
    };
  }

  /**
   * Routine stage: when a routine store + runner are wired, the engine resumes an
   * active routine — or, with an activator wired, starts a new one whose trigger
   * fired — instead of running normal selection/dispatch/compose. Returns null
   * (falling through to the normal turn) when no routine machinery is wired or
   * nothing claims the turn, so behavior is unchanged unless a routine is in play.
   *
   * The user input event is appended only once the turn is committed to a routine,
   * so a non-claiming activation check leaves the normal path to append it.
   */
  /**
   * Post-completion slot correction (issue #746). When a routine has completed and the
   * visitor's latest message edits one of its declared mutable slots, patch the stored
   * value in place and reply — without rerunning the routine or starting a new one.
   *
   * Detection (which slot, what value) is host-owned and model-driven (multilingual); the
   * engine owns the deterministic gate (`verifySlotCorrection`) and never persists a value
   * the gate rejects. Returns null — falling through to normal activation — whenever there
   * is no correction port, no completed instance, no detected correction, or the detected
   * correction fails verification.
   */
  private async tryCompletedRoutineCorrection(
    input: AttemptRoutineInput,
    baseTurn: TurnContext,
    completedStates: RoutineState[],
  ): Promise<ProcessTurnResult | null> {
    if (!input.routineSlotCorrection || !input.routineStore) {
      return null;
    }
    // Single-row state model: at most one completed routine per session (the most recent).
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
      // A correction was detected over a real mutable slot but the new value fails its
      // declared type: re-ask for a valid value rather than silently falling through, so
      // the visitor knows nothing changed and why. `unknown_slot` / `immutable` are
      // defensive (detection only surfaces declared mutable slots) — leave those to the
      // normal turn.
      if (verdict.reason === "invalid_value") {
        const answer = await input.routineSlotCorrection.rejectInvalid({
          turn: baseTurn,
          routineId: completedState.routineId,
          slotKey: candidate.slotKey,
        });
        return this.buildSlotCorrectionTurn(input, completedState.routineId, answer, {
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
    return this.buildSlotCorrectionTurn(input, completedState.routineId, answer, {
      status: "applied",
      // Slot KEY only — never the corrected value (may be PII), per trace conventions.
      outputs: { routineId: completedState.routineId, slotKey: verdict.key },
    });
  }

  /**
   * Shared result builder for a completed-routine slot-correction turn: appends the input +
   * reply events and emits the trace (a `message` stage plus a `routine_slot_correction`
   * stage carrying the given status/outputs — slot keys only, never values).
   */
  private async buildSlotCorrectionTurn(
    input: AttemptRoutineInput,
    routineId: string,
    answer: string,
    correctionStage: { status: ConversationTraceStage["status"]; outputs: Record<string, unknown> },
  ): Promise<ProcessTurnResult> {
    const response: RenderableTurn = { answer };
    const events: ConversationEvent[] = [];
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
  }

  /**
   * Semantic reentry (issue #746). When a routine completed in this conversation and its
   * author chose `semantic` reentry, a host gate decides what the latest message means for
   * it: re-open the same instance (keeping captured variables), start a fresh one, or stay
   * suppressed. Returns the `RoutineState` to run, or null to leave the turn to normal
   * activation — which is also what a non-semantic routine resolves to (the gate returns
   * `suppress` without a model call). Both reentry kinds restart at the root step; slot
   * fast-forwarding skips slots that `resume_existing` carried over.
   */
  private async tryCompletedRoutineReentry(
    input: AttemptRoutineInput,
    baseTurn: TurnContext,
    completedStates: RoutineState[],
  ): Promise<RoutineState | null> {
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
  }

  async attemptRoutine(input: AttemptRoutineInput): Promise<ProcessTurnResult | null> {
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
    // Completed routine instances for this session (single-row model: at most one). Read once
    // and shared by the interceptor and the suppression list below.
    const completedStates = state ? [] : ((await input.routineStore.loadCompleted?.({ sessionId: input.sessionId })) ?? []);
    if (!state) {
      // Completed-instance interceptor (issue #746): before starting a new routine, check
      // whether the visitor is correcting a value captured by the routine that just
      // completed. A confirmed correction patches stored state and replies — it does not
      // start a routine. Anything else falls through to normal activation below.
      const correction = await this.tryCompletedRoutineCorrection(input, baseTurn, completedStates);
      if (correction) {
        return correction;
      }

      // Reentry gate (issue #746): for a completed routine whose author chose semantic
      // reentry, a structured model decision may re-open the same instance (keeping its
      // captured variables) or start a fresh one. Every other case returns null and leaves
      // the turn to normal activation below.
      state = await this.tryCompletedRoutineReentry(input, baseTurn, completedStates);
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
        // Co-compose directives into the clarifying question. No routine is active
        // yet (we're disambiguating which to start), so only global/unscoped
        // directives are eligible — routine/step-scoped ones can't match a routine
        // that hasn't been chosen. The matched steering reaches the clarifier and is
        // traced as `directive_steering`, at parity with the resume path.
        const clarifySteering = await buildResolvedSteering({
          turn: baseTurn,
          directives: input.directives,
          directiveMatcher: input.directiveMatcher,
          steeringResolver: input.steeringResolver,
          baseSteering: [],
          traceKind: "directive_steering",
        });
        const answer = await input.clarifier.phraseQuestion({
          candidates: activation.candidates,
          turn: { ...baseTurn, steering: clarifySteering.steering },
        });
        const response: RenderableTurn = { answer };
        const events: ConversationEvent[] = [];
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
        const messageStage = stage({
          id: "message",
          kind: "message",
          status: "applied",
          outputs: {
            eventId: input.inputEvent.id,
            kind: input.inputEvent.kind,
            contentLength: input.inputEvent.content.length,
            locale: input.inputEvent.locale ?? undefined,
          },
        });
        const historyRefs = history.slice(-HISTORY_TAIL_LIMIT).map((entry, index, slice) => ({
          index: history.length - slice.length + index,
          role: entry.role,
          messageId: entry.id,
          contentLength: entry.content?.length ?? 0,
          createdAt: entry.createdAt,
        }));
        const gatherStage = stage({
          id: "gather",
          kind: "gather",
          status: "applied",
          outputs: { historyCount: history.length, history: historyRefs },
        });
        return createProcessTurnResult({
          sessionId: input.sessionId,
          events,
          decision: {
            selected: [],
            reason: "routine_activation_clarification",
          },
          outcomes: [],
          response,
          trace: createTrace([
            messageStage,
            gatherStage,
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
        // Activation may seed initial variables (e.g. a returning user's email).
        variables: activation.variables ?? {},
        status: "active",
      };
    }

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
          directives: input.directives,
          directiveMatcher: input.directiveMatcher,
          steeringResolver: input.steeringResolver,
          baseSteering,
          traceKind: "directive_steering",
        });
        directiveSteeringStage = resolved.traceStage;
        return resolved.steering;
      },
    };

    // Resume runs before any persistence: a routine may decline (yield) the turn —
    // then the input event is left for the normal path and the routine's position is
    // untouched, so it resumes on a later turn.
    const result = await input.routineRunner.resume({ turn, state, steeringResolver: routineSteeringResolver });
    if (result.yielded) {
      return null;
    }
    if (!directiveSteeringStage) {
      const landedStepId = result.nextState?.path.at(-1) ?? state.path.at(-1);
      const resolved = await buildResolvedSteering({
        turn: { ...turn, activeStepId: landedStepId },
        directives: input.directives,
        directiveMatcher: input.directiveMatcher,
        steeringResolver: input.steeringResolver,
        baseSteering: [],
        traceKind: "directive_steering",
      });
      directiveSteeringStage = resolved.traceStage;
    }

    const events: ConversationEvent[] = [];
    const inputEvent = createInputEvent(input);
    await input.stores.appendEvent(inputEvent);
    events.push(inputEvent);

    if (result.nextState) {
      await input.routineStore.save(result.nextState);
    } else {
      await input.routineStore.save({
        ...state,
        path: result.trace?.landedStepId ? [...state.path, result.trace.landedStepId] : state.path,
        status: "completed",
        metadata: {
          ...(state.metadata ?? {}),
          ...(result.terminal ? { terminalKind: result.terminal.kind, terminalStepId: result.terminal.stepId } : {}),
        },
      });
    }

    const responseEvent = createResponseEvent(input.sessionId, result.response);
    await input.stores.appendEvent(responseEvent);
    events.push(responseEvent);

    const messageStage = stage({
      id: "message",
      kind: "message",
      status: "applied",
      outputs: {
        eventId: input.inputEvent.id,
        kind: input.inputEvent.kind,
        contentLength: input.inputEvent.content.length,
        locale: input.inputEvent.locale ?? undefined,
      },
    });
    const historyRefs = history.slice(-HISTORY_TAIL_LIMIT).map((entry, index, slice) => ({
      index: history.length - slice.length + index,
      role: entry.role,
      messageId: entry.id,
      contentLength: entry.content?.length ?? 0,
      createdAt: entry.createdAt,
    }));
    const gatherStage = stage({
      id: "gather",
      kind: "gather",
      status: "applied",
      outputs: { historyCount: history.length, history: historyRefs },
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
        // Length only — the assistant's reply lives on the chat message record
        // and the UI joins back to it from there.
        answerLength: result.response.answer.length,
      },
      // The runner's step-by-step traversal, carried opaquely for the debug panel
      // (namespace "routine"), mirroring how retrieval hangs its ActivityTrace.
      ...(result.trace ? { subTrace: { namespace: "routine", version: 1, payload: result.trace } } : {}),
    });
    const routineTraceStages = activationClarificationStage
      ? [messageStage, gatherStage, activationClarificationStage, routineStage, directiveSteeringStage]
      : [messageStage, gatherStage, routineStage, directiveSteeringStage];

    return createProcessTurnResult({
      sessionId: input.sessionId,
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
      // Forward the suspend signal so the host can mint a handle, insert the
      // pending_decisions row, and notify an operator. Without this the routine
      // would save status="suspended" and be orphaned (loadActive filters to active).
      awaitingDecision: result.awaitingDecision,
      trace: createTrace(routineTraceStages),
    });
  }

  async resumeAwaitingDecision(input: ResumeAwaitingDecisionInput): Promise<ConversationRoutineDecisionResult> {
    return resumeAwaitingDecision({
      suspendedReader: input.suspendedReader,
      routineRunner: input.routineRunner,
      turn: input.turn,
      sessionId: input.sessionId,
      decision: input.decision,
      ...(input.steeringResolver ? { steeringResolver: input.steeringResolver } : {}),
    });
  }

  async processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult> {
    const resumed = await this.attemptRoutine(input);
    if (resumed) {
      return resumed;
    }
    const prepared = await this.prepareTurn(input);
    const composeStartedAt = Date.now();
    const response = await input.composer.compose({
      turn: prepared.composeTurn,
      outcomes: prepared.outcomes,
      decision: prepared.decision,
    });
    const composeCompletedAt = Date.now();
    prepared.stages.push(timedStage(composeStartedAt, composeCompletedAt, {
      id: "compose",
      kind: "compose",
      status: "applied",
      outputs: composeOutputsFor(response, prepared.outcomes, { streamed: false }),
    }));

    const responseEvent = createResponseEvent(input.sessionId, response);
    await input.stores.appendEvent(responseEvent);
    prepared.events.push(responseEvent);

    return createProcessTurnResult({
      sessionId: input.sessionId,
      events: prepared.events,
      decision: prepared.decision,
      outcomes: prepared.outcomes,
      response,
      trace: createTrace(prepared.stages),
    });
  }

  async *processTurnStream(input: ProcessTurnStreamInput): AsyncIterable<ProcessTurnStreamEvent> {
    const resumed = await this.attemptRoutine(input);
    if (resumed) {
      if (resumed.response.answer) {
        yield { type: "delta", sessionId: input.sessionId, text: resumed.response.answer };
      }
      yield { type: "final", result: resumed };
      return;
    }
    const prepared = await this.prepareTurn(input);
    let response: RenderableTurn | null = null;
    let finalMetadata: Record<string, unknown> | undefined;
    const composeStartedAt = Date.now();

    for await (const event of input.composer.stream({
      turn: prepared.composeTurn,
      outcomes: prepared.outcomes,
      decision: prepared.decision,
    })) {
      if (response) {
        throw new Error("conversation_stream_event_after_final");
      }
      if (event.type === "delta") {
        yield {
          type: "delta",
          sessionId: input.sessionId,
          text: event.text,
          metadata: event.metadata,
        };
        continue;
      }
      response = event.response;
      finalMetadata = event.metadata;
    }

    if (!response) {
      throw new Error("conversation_stream_missing_final");
    }

    const composeCompletedAt = Date.now();
    prepared.stages.push(timedStage(composeStartedAt, composeCompletedAt, {
      id: "compose",
      kind: "compose",
      status: "applied",
      outputs: composeOutputsFor(response, prepared.outcomes, { streamed: true }),
    }));

    const responseEvent = createResponseEvent(input.sessionId, response);
    await input.stores.appendEvent(responseEvent);
    prepared.events.push(responseEvent);

    yield {
      type: "final",
      result: createProcessTurnResult({
        sessionId: input.sessionId,
        events: prepared.events,
        decision: prepared.decision,
        outcomes: prepared.outcomes,
        response,
        trace: createTrace(prepared.stages),
      }),
      metadata: finalMetadata,
    };
  }
}

export const createConversationEngine = (): ConversationEngine => new DefaultConversationEngine();

export { DefaultRoutineRunner } from "./routineRunner.js";
export { resumeAwaitingDecision } from "./awaitingDecision.js";
export {
  verifySlotCorrection,
  type SlotCorrectionResult,
  type SlotCorrectionRejection,
} from "./slotCorrection.js";
export {
  clarificationStage,
  decideClarification,
  orderClarificationCandidates,
  resolvePendingClarification,
  type ClarificationDecisionContext,
  type PendingClarificationResolution,
} from "./clarification.js";
