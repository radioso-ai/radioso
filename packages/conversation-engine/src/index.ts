export {
  addressesSurface,
  effectiveSurfaces,
  resolveRenderSurfaces,
  steeringForSurface,
} from "./generationSurface.js";
import type {
  AttemptRoutineInput,
  ConversationEngine,
  ConversationEvent,
  AwaitingSkillInput,
  ConversationSkillInputResolution,
  ConversationTraceStage,
  ProcessTurnInput,
  ProcessTurnResult,
  ProcessTurnStreamEvent,
  ProcessTurnStreamInput,
  RenderableTurn,
  ResumeAwaitingDecisionInput,
  ConversationRoutineDecisionResult,
  SelectionDecision,
  SkillDefinition,
  SelectedSkill,
  TurnContext,
  TurnOutcome,
} from "@radioso/conversation-contract";

import { resumeAwaitingDecision } from "./awaitingDecision.js";
import { attemptRoutine } from "./routineActivation.js";
import { buildResolvedSteering } from "./steering.js";
import {
  createInputEvent,
  createProcessTurnResult,
  createResponseEvent,
  createTrace,
  historyGatherStage,
  reportProgress,
  skillInputResolutionStage,
  stage,
  timedStage,
} from "./traceStages.js";
import {
  composeAdherenceLinks,
  composeOutputsFor,
  composeTraceMetricsFor,
  findSkill,
  guidanceToSteering,
  mergeStagedContext,
  missingSkillOutcome,
  skillInputSteering,
  summarizeInterpretation,
} from "./traceSummaries.js";

interface PreparedTurnRun {
  stages: ConversationTraceStage[];
  events: ConversationEvent[];
  decision: SelectionDecision;
  outcomes: TurnOutcome[];
  composeTurn: TurnContext;
  awaitingSkillInput?: AwaitingSkillInput[];
}

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

    // Tail of the loaded history is represented as structural references only;
    // the UI resolves message text from the authorized conversation records.
    stages.push(historyGatherStage(history));

    const interpretationStartedAt = Date.now();
    if (input.turnInterpreter) {
      reportProgress(input, "interpreting");
    }
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
    if (shouldRunRetrieval) {
      reportProgress(input, "retrieving");
    }
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
    reportProgress(input, "selecting");
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

    // Every resolver call gets its own copy of the pre-dispatch turn. Sharing one object
    // would let a host resolver mutate what it was handed and change what the next
    // resolver sees, which is precisely the cross-skill coupling D1 exists to prevent.
    // Element objects are still shared with the dispatch path, so this bounds container
    // mutation rather than deep-freezing state the rest of the turn also reads.
    const preDispatchSnapshot = (): TurnContext => ({
      ...selectedTurn,
      history: [...selectedTurn.history],
      stagedContext: [...selectedTurn.stagedContext],
      steering: [...selectedTurn.steering],
    });
    const resolvedSelections: Array<{ skill: SkillDefinition; selected: SelectedSkill; resolution?: ConversationSkillInputResolution }> = [];
    const awaitingSkillInput: AwaitingSkillInput[] = [];
    const preflightOutcomes: TurnOutcome[] = [];
    let hasFailedResolution = false;

    for (const selected of decision.selected) {
      const resolutionStartedAt = Date.now();
      const skill = findSkill(input.skills, selected.skillName);
      if (!skill) {
        const resolution: ConversationSkillInputResolution = {
          kind: "failed",
          code: "skill_not_found",
          fields: [],
        };
        stages.push(skillInputResolutionStage({
          skillName: selected.skillName,
          resolution,
          startedAtMs: resolutionStartedAt,
          completedAtMs: Date.now(),
        }));
        const failed = missingSkillOutcome(selected.skillName, selectedTurn.steering);
        preflightOutcomes.push(failed);
        stages.push(...failed.trace.stages);
        hasFailedResolution = true;
        continue;
      }
      // A skill that declares no fields has nothing to resolve, so it emits no stage.
      // FR-015 keeps such a skill behaving exactly as it did before this feature, and a
      // stage reporting "nothing to do" on every turn would be trace noise for the many
      // hosts that declare no fields at all.
      if ((skill.inputSchema?.fields.length ?? 0) === 0) {
        resolvedSelections.push({ skill, selected });
        continue;
      }
      const resolution = input.skillInputResolver
        ? await input.skillInputResolver.resolve({ skill, selected, turn: preDispatchSnapshot() })
        : { kind: "failed", code: "skill_input_resolver_unavailable", fields: [] } as ConversationSkillInputResolution;
      stages.push(skillInputResolutionStage({
        skillName: selected.skillName,
        resolution,
        startedAtMs: resolutionStartedAt,
        completedAtMs: Date.now(),
      }));
      if (resolution.kind === "failed") {
        hasFailedResolution = true;
        continue;
      }
      if (resolution.kind === "needs_input") {
        awaitingSkillInput.push({ skillName: selected.skillName, fields: resolution.outstanding });
        continue;
      }
      resolvedSelections.push({ skill, selected: { ...selected, input: resolution.input }, resolution });
    }

    // A turn either asks for missing input or it does not, and the reported
    // `awaitingSkillInput` must describe what was actually asked. A failed resolution is
    // not an ask (D11): it composes an ordinary reply. So when a failure and a
    // needs-input land in the same turn, the failure dominates and nothing is reported as
    // awaited — otherwise the result would claim the turn asked for fields it never
    // mentioned. Per-field detail stays visible on the resolution trace stage either way.
    // Both the steering and the report read this one flag so they cannot diverge.
    const asksForSkillInput = !hasFailedResolution && awaitingSkillInput.length > 0;
    const outcomes: TurnOutcome[] = [...preflightOutcomes];
    let mergedSteering = [...selectedTurn.steering];
    if (!hasFailedResolution && awaitingSkillInput.length === 0) {
      for (const { skill, selected } of resolvedSelections) {

      const turnForSkill: TurnContext = {
        ...selectedTurn,
        stagedContext: [...selectedTurn.stagedContext, ...mergeStagedContext(outcomes)],
        steering: mergedSteering,
      };
      const dispatchStartedAt = Date.now();
      reportProgress(input, "dispatching");
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
    } else if (asksForSkillInput) {
      mergedSteering = [...mergedSteering, skillInputSteering(awaitingSkillInput)];
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
      ...(asksForSkillInput ? { awaitingSkillInput } : {}),
    };
  }

  /** Runs the routine path before ordinary skill selection when the host wires it. */
  async attemptRoutine(input: AttemptRoutineInput): Promise<ProcessTurnResult | null> {
    return attemptRoutine(input);
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
      trace: createTrace(prepared.stages, composeAdherenceLinks(response)),
      awaitingSkillInput: prepared.awaitingSkillInput,
    });
  }

  async *processTurnStream(input: ProcessTurnStreamInput): AsyncIterable<ProcessTurnStreamEvent> {
    const resumed = await this.attemptRoutine(input);
    if (resumed) {
      const chunks = input.composer.streamCommitted?.(resumed.response)
        ?? (resumed.response.answer ? [resumed.response.answer] : []);
      for (const text of chunks) {
        if (text) {
          yield { type: "delta", sessionId: input.sessionId, text };
        }
      }
      yield { type: "final", result: resumed };
      return;
    }
    const prepared = await this.prepareTurn(input);
    let response: RenderableTurn | null = null;
    let finalMetadata: Record<string, unknown> | undefined;
    const composeStartedAt = Date.now();
    reportProgress(input, "composing");

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
      metrics: composeTraceMetricsFor(response),
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
        trace: createTrace(prepared.stages, composeAdherenceLinks(response)),
        awaitingSkillInput: prepared.awaitingSkillInput,
      }),
      metadata: finalMetadata,
    };
  }
}

export const createConversationEngine = (): ConversationEngine => new DefaultConversationEngine();

export { DefaultRoutineRunner } from "./routineRunner.js";
export { resumeAwaitingDecision } from "./awaitingDecision.js";
export { DefaultSteeringResolver, isDirectiveEligibleForTurn } from "./steering.js";
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
