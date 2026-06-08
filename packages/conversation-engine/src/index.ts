import type {
  AttemptRoutineInput,
  ConversationEngine,
  ConversationEvent,
  ConversationTrace,
  ConversationTraceStage,
  Directive,
  DirectiveMatch,
  ProcessTurnInput,
  ProcessTurnResult,
  ProcessTurnStreamEvent,
  ProcessTurnStreamInput,
  RenderableTurn,
  RoutineActionRequest,
  SelectionDecision,
  SkillDefinition,
  SkillTransientGuidance,
  StagedContext,
  SteeringResolver,
  SteeringRule,
  TurnContext,
  TurnOutcome,
} from "@radioso/conversation-contract";

const nowIso = (): string => new Date().toISOString();

const stage = (input: Omit<ConversationTraceStage, "startedAt" | "completedAt">): ConversationTraceStage => {
  const timestamp = nowIso();
  return {
    ...input,
    startedAt: timestamp,
    completedAt: timestamp,
  };
};

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
}): ConversationTraceStage => stage({
  id: input.id,
  kind: input.kind,
  status: input.matches.length > 0 ? "applied" : "skipped",
  outputs: {
    matchCount: input.matches.length,
    directives: input.kind === "directive_steering"
      ? input.matches.map((match) => ({
          id: match.directive.id,
          name: match.directive.name,
        }))
      : input.matches.map(summarizeDirectiveMatch),
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

  return {
    steering,
    directiveMatches,
    traceStage: buildDirectiveTraceStage({
      id: input.traceKind === "directive_steering" ? "directive_steering" : "directives",
      kind: input.traceKind ?? "directive_match",
      matches: directiveMatches,
      candidateCount: eligibleDirectives.length,
      scopeFilteredCount: directives.length - eligibleDirectives.length,
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
  sessionId,
  kind: "assistant.response",
  role: "assistant",
  content: response.answer,
  metadata: response.metadata,
  createdAt: nowIso(),
});

const createProcessTurnResult = (input: {
  sessionId: string;
  events: ConversationEvent[];
  decision: SelectionDecision;
  outcomes: TurnOutcome[];
  response: RenderableTurn;
  trace: ConversationTrace;
  actions?: RoutineActionRequest[];
}): ProcessTurnResult => ({
  sessionId: input.sessionId,
  events: input.events,
  decision: input.decision,
  outcomes: input.outcomes,
  response: input.response,
  trace: input.trace,
  ...(input.actions && input.actions.length > 0 ? { actions: input.actions } : {}),
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

    const resolved = await buildResolvedSteering({
      turn: baseTurn,
      directives: input.directives,
      directiveMatcher: input.directiveMatcher,
      steeringResolver: input.steeringResolver,
    });
    const directiveMatches = resolved.directiveMatches;
    const directiveSteering = resolved.steering;
    stages.push(resolved.traceStage);

    const selectedTurn: TurnContext = {
      ...baseTurn,
      steering: directiveSteering,
    };
    const decision = await input.selector.select({
      turn: selectedTurn,
      skills: input.skills,
      directives: directiveMatches,
    });
    stages.push(stage({
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
    let mergedSteering = [...directiveSteering];
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
        stagedContext: mergeStagedContext(outcomes),
        steering: mergedSteering,
      };
      const outcome = await input.dispatcher.dispatch({
        skill,
        turn: turnForSkill,
        selected,
      });
      const skillGuidance = (outcome.outcome.guidance ?? []).map((guidance) =>
        guidanceToSteering(guidance, outcome.outcome.control?.lifespan === "session" ? 100 : undefined)
      );
      mergedSteering = [...mergedSteering, ...skillGuidance];
      outcomes.push({
        ...outcome,
        steering: [...outcome.steering, ...skillGuidance],
      });
      stages.push(stage({
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
      stagedContext: mergeStagedContext(outcomes),
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
    if (!state) {
      if (!input.routineActivator) {
        return null;
      }
      const activation = await input.routineActivator.activate({ turn: baseTurn });
      if (!activation) {
        return null;
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
      resolve: async ({ baseSteering }: { baseSteering: SteeringRule[] }): Promise<SteeringRule[]> => {
        const resolved = await buildResolvedSteering({
          turn,
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
      const resolved = await buildResolvedSteering({
        turn,
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
      await input.routineStore.clear({ sessionId: input.sessionId });
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
        // Length only — the assistant's reply lives on the chat message record
        // and the UI joins back to it from there.
        answerLength: result.response.answer.length,
      },
    });

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
      trace: createTrace([messageStage, gatherStage, routineStage, directiveSteeringStage]),
    });
  }

  async processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult> {
    const resumed = await this.attemptRoutine(input);
    if (resumed) {
      return resumed;
    }
    const prepared = await this.prepareTurn(input);
    const response = await input.composer.compose({
      turn: prepared.composeTurn,
      outcomes: prepared.outcomes,
      decision: prepared.decision,
    });
    prepared.stages.push(stage({
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

    prepared.stages.push(stage({
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
