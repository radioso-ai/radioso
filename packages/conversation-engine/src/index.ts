import type {
  ConversationEngine,
  ConversationEvent,
  ConversationTrace,
  ConversationTraceStage,
  DirectiveMatch,
  ProcessTurnInput,
  ProcessTurnResult,
  ProcessTurnStreamEvent,
  ProcessTurnStreamInput,
  RenderableTurn,
  SelectionDecision,
  SkillDefinition,
  SkillTransientGuidance,
  StagedContext,
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

const directiveMatchToSteering = (match: DirectiveMatch): SteeringRule => ({
  action: match.directive.action,
  condition: match.directive.condition.kind === "contextual"
    ? match.directive.condition.description
    : undefined,
  priority: match.directive.priority,
  criticality: match.directive.criticality,
  description: match.directive.description,
  source: "directive",
  lifespan: "response",
});

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

const createInputEvent = (input: ProcessTurnInput | ProcessTurnStreamInput): ConversationEvent => ({
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
}): ProcessTurnResult => ({
  sessionId: input.sessionId,
  events: input.events,
  decision: input.decision,
  outcomes: input.outcomes,
  response: input.response,
  trace: input.trace,
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
    stages.push(stage({
      id: "gather",
      kind: "gather",
      status: "applied",
      outputs: { historyCount: history.length },
    }));

    const directiveMatches = await input.directiveMatcher.match({
      turn: baseTurn,
      directives: input.directives,
    });
    const directiveSteering = directiveMatches.map(directiveMatchToSteering);
    stages.push(stage({
      id: "directives",
      kind: "directive_match",
      status: directiveMatches.length > 0 ? "applied" : "skipped",
      outputs: { matchCount: directiveMatches.length },
    }));

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

  async processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult> {
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
      outputs: { outcomeCount: prepared.outcomes.length },
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
      outputs: { outcomeCount: prepared.outcomes.length, streamed: true },
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
