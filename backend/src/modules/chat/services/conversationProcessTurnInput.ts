import { GENERATION_SURFACE } from "../../../shared/domain/generationSurface.js";
import type {
  AttemptRoutineInput,
  ConversationEvent,
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationCoverageRoutineActivator,
  ConversationCoverageReactionRecorder,
  ConversationModelGateway,
  ConversationProgressPort,
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineSlotCorrection,
  ConversationRoutineRunner,
  ConversationRoutineStore,
  ConversationRetrievalWorkPort,
  ConversationSkillDispatcher,
  ConversationSkillSelector,
  ConversationTurnInterpreter,
  ConversationTurnComposer,
  ConversationTurnStreamComposer,
  Directive,
  DirectiveMatch,
  ProcessTurnInput,
  ProcessTurnStreamInput,
  SkillDefinition,
  TurnContext,
} from "@radioso/conversation-contract";

import type { PreparedSession } from "./chatSessionPreparer.js";
import type { RouteScopedDirectiveRuntime } from "./routeScopedDirectiveSteering.js";
import { DeferredDirectiveStateStore } from "./directives/deferredDirectiveStateStore.js";
import {
  partitionDirectivesByLifecycle,
  renderedDirectiveNames,
  type DirectiveStateStore,
} from "../../directives/public.js";
import {
  toConversationAgentConfig,
  toConversationInputEvent,
  toConversationMessages,
} from "./conversationContractMappers.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import { visitorMatchContext } from "./visitorMatchContext.js";
import { steeringDirectivesFromAuthored } from "../../agents/public.js";
import { planAwareDirectiveClassifications } from "./turnPlanCoordinator.js";

const missingModelGateway: ConversationModelGateway = {
  async complete(): Promise<{ text: string }> {
    throw new Error("conversation_model_gateway_not_configured");
  },
};

interface ChatProcessTurnInputOptions {
  session: PreparedSession;
  accountId?: string;
  skills?: SkillDefinition[];
  directives?: Directive[];
  dispatcher: ConversationSkillDispatcher;
  selector: ConversationSkillSelector;
  composer: ConversationTurnComposer;
  directiveRuntime?: RouteScopedDirectiveRuntime;
  directiveStateStore?: DirectiveStateStore;
  modelGateway?: ConversationModelGateway;
  appendEvent?: (event: ConversationEvent) => Promise<void>;
  // Routine machinery (optional, all three travel together). Present only when the
  // host registered routines for this turn; absent leaves turn behavior unchanged.
  routineStore?: ConversationRoutineStore;
  routineRunner?: ConversationRoutineRunner;
  routineActivator?: ConversationRoutineActivator;
  coverageRoutineActivator?: ConversationCoverageRoutineActivator;
  clarifier?: ConversationClarifier;
  clarificationStore?: ConversationClarificationStore;
  loopGuardCandidateIds?: string[];
  suppressNewClarification?: boolean;
  turnInterpreter?: ConversationTurnInterpreter;
  retrievalWork?: ConversationRetrievalWorkPort;
  getSession?: () => PreparedSession;
  coverageReactionRecorder?: ConversationCoverageReactionRecorder;
}

interface ChatProcessTurnStreamInputOptions extends Omit<ChatProcessTurnInputOptions, "composer"> {
  composer: ConversationTurnStreamComposer;
  progress?: ConversationProgressPort;
}

// Lazily bind a per-turn deferred directive-state store to the session, keyed by
// the session object (which is stable for the turn once the answer runs). Returns
// undefined when the host wired no durable store, leaving matching unchanged.
const attachDirectiveStateStore = (
  session: PreparedSession,
  inner?: DirectiveStateStore,
): DeferredDirectiveStateStore | undefined => {
  if (session.directiveStateStore) {
    return session.directiveStateStore;
  }
  if (!inner) {
    return undefined;
  }
  const store = new DeferredDirectiveStateStore(inner, session.conversation.id);
  session.directiveStateStore = store;
  return store;
};

const directiveMatchesForSession = (session: PreparedSession): DirectiveMatch[] =>
  session.directiveSteering?.matches ?? [];

const directivesForSession = (session: PreparedSession): Directive[] =>
  directiveMatchesForSession(session).map((match) => match.directive);

const authoredDirectivesForSession = (session: PreparedSession): Directive[] =>
  steeringDirectivesFromAuthored(session.agent.authoredDirectives);

const effectiveInputEventForSession = (session: PreparedSession) => ({
  ...toConversationInputEvent(session.userMessage),
  content: session.effectiveQuery ?? session.userMessage.content,
});

/**
 * The turn's resolved visitor context, bounded for matching. Always sent: it carries the caller
 * kind even on a turn that resolved no context variable, because a directive condition cannot be
 * written against a key that is only sometimes there.
 */
const visitorContextForMatching = (
  session: PreparedSession,
): { visitorContext: Record<string, unknown> } => ({ visitorContext: visitorMatchContext(session).context });

const directiveSteerInputForSession = (
  session: PreparedSession,
  accountId?: string,
  turn?: Pick<TurnContext, "inputEvent">,
) => ({
  workspaceId: session.agent.workspaceId,
  accountId,
  additionalDirectives: authoredDirectivesForSession(session),
  turnContext: {
    query: turn?.inputEvent.content ?? session.effectiveQuery ?? session.userMessage.content,
    route: session.turnRoute,
    ...visitorContextForMatching(session),
  },
  usageContext: {
    accountId: accountId ?? null,
    workspaceId: session.agent.workspaceId,
    conversationId: session.conversation.id,
    messageId: session.userMessage.id,
    surface: "chat",
    operation: "directive_match",
    attemptKey: `${session.userMessage.id}:directive_match`,
    ...session.usageAttribution,
  },
});

const buildDirectiveTurnWiring = (options: {
  session: PreparedSession;
  getSession?: () => PreparedSession;
  accountId?: string;
  directives?: Directive[];
  directiveRuntime?: RouteScopedDirectiveRuntime;
  directiveStateStore?: DirectiveStateStore;
}): Pick<ProcessTurnInput, "directives" | "directiveMatcher"> => {
  const directivesForRoutes = (): Directive[] => {
    if (!options.directiveRuntime) {
      return directivesForSession(options.session);
    }
    const byName = new Map<string, Directive>();
    for (const route of new Set([options.session.turnRoute, CHAT_TURN_ROUTE.DIRECT, CHAT_TURN_ROUTE.RETRIEVAL])) {
      const sessionForRoute = { ...options.session, turnRoute: route };
      for (const directive of options.directiveRuntime.directivesFor(
        directiveSteerInputForSession(sessionForRoute, options.accountId),
      )) {
        byName.set(directive.name, directive);
      }
    }
    return [...byName.values()];
  };
  // Raw match candidates accumulated across every `match()` call this turn. The
  // engine calls the matcher once per directive group on a retrieval turn — legacy
  // directives, then coverage directives (packages/conversation-engine/src/index.ts)
  // — and a coverage-offer clarification can call it a third time
  // (packages/conversation-engine/src/routineActivation.ts's `clarify` branch,
  // invoked from the coverage verdict sink) — and each call must resolve against
  // everything matched so far, not just its own group: DirectiveSteeringService.
  // resolveMatches applies capability denial, excludes/dependsOn, and the steering
  // bound over its whole input, so resolving each group independently and keeping
  // only the last result would drop the earlier call's directives from
  // `session.directiveSteering.matches` (read by directive-to-skill binding and the
  // Activity trace) and would bound each group against its own budget instead of
  // the one shared budget. This closure is rebuilt per turn by
  // createChatProcessTurnInput/createChatProcessTurnStreamInput/
  // createAttemptRoutineInput, so the accumulator resets with it.
  const turnMatchCandidates: DirectiveMatch[] = [];
  // Directive names already present in the accumulator (round 3, Q2): a later
  // call can re-request a directive an earlier call already matched this turn
  // (the coverage-offer clarification re-requests both the legacy and the
  // criteria-eligible coverage directives) — pushing a second raw match for the
  // same directive would resolve into two SteeringRules for one directive, each
  // with its own host id, doubling every directive in the turn's final steering.
  const accumulatedCandidateNames = new Set<string>();
  return {
    directives: options.directives ?? directivesForRoutes(),
    directiveMatcher: {
      async match({ turn, directives }) {
        const session = options.getSession?.() ?? options.session;
        const runtime = options.directiveRuntime;
        if (!runtime) {
          return directiveMatchesForSession(session);
        }
        const steerInput = directiveSteerInputForSession(session, options.accountId, turn);
        const scopedDirectives = runtime.directivesFor(steerInput);
        const candidateByName = new Map(directives.map((directive) => [directive.name, directive]));
        const scopeEligible = scopedDirectives.filter((directive) => candidateByName.has(directive.name));
        // Cross-turn firing memory: suppress once/cooldown directives that already
        // fired, before matching — this also skips the contextual-match LLM call
        // for them. Directives without lifecycle stay eligible (repeatable default).
        // The per-turn deferred store rides on the session (like directiveSteering)
        // so the routine attempt and process turn share one instance, committed once
        // at turn completion.
        const store = attachDirectiveStateStore(session, options.directiveStateStore);
        // Taking ownership before matching makes a lifecycle baseline stable across
        // app instances. This remains all-turn state: cooldown age advances even
        // on a route whose current scope contains no lifecycle directive.
        const firingState = store ? await store.load() : undefined;
        const { eligible: currentRouteDirectives, trackedNames, suppressed } =
          partitionDirectivesByLifecycle(scopeEligible, firingState);
        // Fused turn planning already classified the route-scoped union of
        // contextual directives. When a plan is present, narrow its opaque
        // identities to this route and resolve steering from the resulting real
        // directive names — no directive-match model call.
        const plannedClassifications = await planAwareDirectiveClassifications(
          () => session.turnPlan?.resolve(null),
          session.turnRoute,
        );
        const candidates = await runtime.matchCandidates(
          steerInput,
          currentRouteDirectives,
          plannedClassifications ?? undefined,
        );
        for (const candidate of candidates) {
          if (!accumulatedCandidateNames.has(candidate.directive.name)) {
            turnMatchCandidates.push(candidate);
            accumulatedCandidateNames.add(candidate.directive.name);
          }
        }
        // Resolve over every candidate matched so far this turn (see the accumulator
        // comment above) rather than just this call's — the single source of truth
        // for `session.directiveSteering` from here on is this union resolve.
        const steering = await runtime.resolveMatches(steerInput, turnMatchCandidates);
        // Every turn that reaches an answer renders the answering voice. The
        // follow-up question generator is added later, and only if one shows.
        steering.renderedSurfaces = [GENERATION_SURFACE.ANSWER];
        if (store && firingState) {
          if (trackedNames.size > 0) {
            // The answer steering block renders as part of this turn's reply, so a
            // directive addressed to the answering voice has fired by now.
            const answerFired = renderedDirectiveNames(steering, GENERATION_SURFACE.ANSWER)
              .filter((name) => trackedNames.has(name));
            store.capture(answerFired);
            // A directive addressed only to a later generator has matched, not fired.
            // The follow-up question block renders only when suggestions are actually
            // generated, so consuming a once/cooldown budget here would spend it on a
            // turn that never showed the rule. The rendering host captures these
            // only after final filtering leaves visitor-visible output.
            const alreadyFired = new Set(answerFired);
            const pendingSuggestions = renderedDirectiveNames(
              steering,
              GENERATION_SURFACE.SUGGESTED_QUESTIONS,
            ).filter((name) => trackedNames.has(name) && !alreadyFired.has(name));
            if (pendingSuggestions.length > 0) {
              steering.pendingSurfaceFirings = {
                [GENERATION_SURFACE.SUGGESTED_QUESTIONS]: pendingSuggestions,
              };
            }
          }
          if (suppressed.length > 0) {
            steering.lifecycleSuppressed = suppressed;
          }
        }
        const currentSession = options.getSession?.() ?? session;
        currentSession.directiveSteering = steering;
        // Bound flags (capability denial, excludes/dependsOn, the steering bound)
        // are decided over the whole turn's accumulated candidates, but this call
        // must still hand back only the directives it was itself asked to match —
        // otherwise a later group's caller (the coverage matcher, the coverage-offer
        // clarifier) would receive an earlier group's directives too, e.g. a legacy
        // directive riding into the coverage verdict sink's `coverageDirectiveMatches`
        // and getting recorded as a spurious coverage reaction (round 3 review, Q1).
        const thisCallCandidateNames = new Set(candidates.map((candidate) => candidate.directive.name));
        return steering.matches.filter((match) => thisCallCandidateNames.has(match.directive.name));
      },
    },
  };
};

export const createChatProcessTurnInput = (options: ChatProcessTurnInputOptions): ProcessTurnInput => {
  const directiveWiring = buildDirectiveTurnWiring(options);
  const readSession = options.getSession ?? (() => options.session);
  return {
    agent: toConversationAgentConfig(readSession().agent),
    sessionId: readSession().conversation.id,
    inputEvent: effectiveInputEventForSession(readSession()),
    skills: options.skills ?? [],
    directives: directiveWiring.directives,
    ...(options.coverageReactionRecorder ? { coverageReactionRecorder: options.coverageReactionRecorder } : {}),
    stores: {
      async loadHistory() {
        return toConversationMessages(readSession().history);
      },
      async appendEvent(event) {
        await options.appendEvent?.(event);
      },
    },
    modelGateway: options.modelGateway ?? missingModelGateway,
    dispatcher: options.dispatcher,
    selector: options.selector,
    composer: options.composer,
    directiveMatcher: directiveWiring.directiveMatcher,
    ...(options.turnInterpreter ? { turnInterpreter: options.turnInterpreter } : {}),
    ...(options.retrievalWork ? { retrievalWork: options.retrievalWork } : {}),
    ...(options.routineStore ? { routineStore: options.routineStore } : {}),
    ...(options.routineRunner ? { routineRunner: options.routineRunner } : {}),
    ...(options.routineActivator ? { routineActivator: options.routineActivator } : {}),
    ...(options.coverageRoutineActivator ? { coverageRoutineActivator: options.coverageRoutineActivator } : {}),
    ...(options.clarifier ? { clarifier: options.clarifier } : {}),
    ...(options.clarificationStore ? { clarificationStore: options.clarificationStore } : {}),
    ...(options.loopGuardCandidateIds ? { loopGuardCandidateIds: options.loopGuardCandidateIds } : {}),
    ...(options.suppressNewClarification ? { suppressNewClarification: options.suppressNewClarification } : {}),
  };
};

export const createChatProcessTurnStreamInput = (
  options: ChatProcessTurnStreamInputOptions,
): ProcessTurnStreamInput => ({
  ...createChatProcessTurnInput(options),
  composer: options.composer,
  ...(options.progress ? { progress: options.progress } : {}),
});

interface AttemptRoutineInputOptions {
  session: PreparedSession;
  accountId?: string;
  directives?: Directive[];
  directiveRuntime?: RouteScopedDirectiveRuntime;
  directiveStateStore?: DirectiveStateStore;
  appendEvent?: (event: ConversationEvent) => Promise<void>;
  routineStore?: ConversationRoutineStore;
  routineRunner?: ConversationRoutineRunner;
  routineActivator?: ConversationRoutineActivator;
  routineSlotCorrection?: ConversationRoutineSlotCorrection;
  routineReentryGate?: ConversationRoutineReentryGate;
  clarifier?: ConversationClarifier;
  clarificationStore?: ConversationClarificationStore;
  loopGuardCandidateIds?: string[];
  suppressNewClarification?: boolean;
  progress?: ConversationProgressPort;
}

/**
 * Builds the narrow input `engine.attemptRoutine` needs — agent, session, input event,
 * stores, directive steering, and routine machinery only. Routine resume/activation
 * never runs selection, dispatch, or composition, so unlike
 * {@link createChatProcessTurnInput} this wires no stub selector/dispatcher/composer.
 */
export const createAttemptRoutineInput = (options: AttemptRoutineInputOptions): AttemptRoutineInput => {
  const directiveWiring = buildDirectiveTurnWiring(options);
  return {
    agent: toConversationAgentConfig(options.session.agent),
    sessionId: options.session.conversation.id,
    inputEvent: effectiveInputEventForSession(options.session),
    stores: {
      async loadHistory() {
        return toConversationMessages(options.session.history);
      },
      async appendEvent(event) {
        await options.appendEvent?.(event);
      },
    },
    directives: directiveWiring.directives,
    directiveMatcher: directiveWiring.directiveMatcher,
    ...(options.routineStore ? { routineStore: options.routineStore } : {}),
    ...(options.routineRunner ? { routineRunner: options.routineRunner } : {}),
    ...(options.routineActivator ? { routineActivator: options.routineActivator } : {}),
    ...(options.routineSlotCorrection ? { routineSlotCorrection: options.routineSlotCorrection } : {}),
    ...(options.routineReentryGate ? { routineReentryGate: options.routineReentryGate } : {}),
    ...(options.clarifier ? { clarifier: options.clarifier } : {}),
    ...(options.clarificationStore ? { clarificationStore: options.clarificationStore } : {}),
    ...(options.loopGuardCandidateIds ? { loopGuardCandidateIds: options.loopGuardCandidateIds } : {}),
    ...(options.suppressNewClarification ? { suppressNewClarification: options.suppressNewClarification } : {}),
    ...(options.progress ? { progress: options.progress } : {}),
  };
};
