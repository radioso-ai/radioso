import type {
  AttemptRoutineInput,
  ConversationEvent,
  ConversationClarificationStore,
  ConversationClarifier,
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
import { authoredDirectiveToSteeringDirective } from "../../agents/public.js";
import { planAwareDirectiveClassifications } from "./turnPlanCoordinator.js";

const missingModelGateway: ConversationModelGateway = {
  async complete(): Promise<{ text: string }> {
    throw new Error("conversation_model_gateway_not_configured");
  },
};

export interface ChatProcessTurnInputOptions {
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
  clarifier?: ConversationClarifier;
  clarificationStore?: ConversationClarificationStore;
  loopGuardCandidateIds?: string[];
  suppressNewClarification?: boolean;
  turnInterpreter?: ConversationTurnInterpreter;
  retrievalWork?: ConversationRetrievalWorkPort;
  getSession?: () => PreparedSession;
}

export interface ChatProcessTurnStreamInputOptions extends Omit<ChatProcessTurnInputOptions, "composer"> {
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
  (session.agent.authoredDirectives ?? []).map(authoredDirectiveToSteeringDirective);

const effectiveInputEventForSession = (session: PreparedSession) => ({
  ...toConversationInputEvent(session.userMessage),
  content: session.effectiveQuery ?? session.userMessage.content,
});

/**
 * The turn's resolved visitor context, bounded for matching. Omitted entirely
 * when nothing resolved, so turns without context variables send the matcher the
 * same signals they always did.
 */
const visitorContextForMatching = (
  session: PreparedSession,
): { visitorContext?: Record<string, unknown> } => {
  const { context } = visitorMatchContext(session);
  return Object.keys(context).length > 0 ? { visitorContext: context } : {};
};

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
        const steering = plannedClassifications
          ? await runtime.matchAndResolveWithClassifications(steerInput, currentRouteDirectives, plannedClassifications)
          : await runtime.matchAndResolve(steerInput, currentRouteDirectives);
        if (store && firingState) {
          if (trackedNames.size > 0) {
            store.capture(renderedDirectiveNames(steering).filter((name) => trackedNames.has(name)));
          }
          if (suppressed.length > 0) {
            steering.lifecycleSuppressed = suppressed;
          }
        }
        const currentSession = options.getSession?.() ?? session;
        currentSession.directiveSteering = steering;
        return steering.matches;
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

export interface AttemptRoutineInputOptions {
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
