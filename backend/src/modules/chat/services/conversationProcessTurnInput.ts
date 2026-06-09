import type {
  AttemptRoutineInput,
  ConversationEvent,
  ConversationModelGateway,
  ConversationRoutineActivator,
  ConversationRoutineRunner,
  ConversationRoutineStore,
  ConversationSkillDispatcher,
  ConversationSkillSelector,
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
import {
  toConversationAgentConfig,
  toConversationInputEvent,
  toConversationMessages,
} from "./conversationContractMappers.js";
import { authoredDirectiveToSteeringDirective } from "../../agents/public.js";

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
  modelGateway?: ConversationModelGateway;
  appendEvent?: (event: ConversationEvent) => Promise<void>;
  // Routine machinery (optional, all three travel together). Present only when the
  // host registered routines for this turn; absent leaves turn behavior unchanged.
  routineStore?: ConversationRoutineStore;
  routineRunner?: ConversationRoutineRunner;
  routineActivator?: ConversationRoutineActivator;
}

export interface ChatProcessTurnStreamInputOptions extends Omit<ChatProcessTurnInputOptions, "composer"> {
  composer: ConversationTurnStreamComposer;
}

const directiveMatchesForSession = (session: PreparedSession): DirectiveMatch[] =>
  session.directiveSteering?.matches ?? [];

const directivesForSession = (session: PreparedSession): Directive[] =>
  directiveMatchesForSession(session).map((match) => match.directive);

const authoredDirectivesForSession = (session: PreparedSession): Directive[] =>
  (session.agent.authoredDirectives ?? []).map(authoredDirectiveToSteeringDirective);

const directiveSteerInputForSession = (
  session: PreparedSession,
  accountId?: string,
  turn?: Pick<TurnContext, "inputEvent">,
) => ({
  workspaceId: session.agent.workspaceId,
  accountId,
  additionalDirectives: authoredDirectivesForSession(session),
  turnContext: {
    query: turn?.inputEvent.content ?? session.userMessage.content,
    route: session.turnRoute,
  },
  usageContext: {
    accountId: accountId ?? null,
    workspaceId: session.agent.workspaceId,
    conversationId: session.conversation.id,
    messageId: session.userMessage.id,
    surface: "chat",
    operation: "directive_match",
    attemptKey: `${session.userMessage.id}:directive_match`,
  },
});

const buildDirectiveTurnWiring = (options: {
  session: PreparedSession;
  accountId?: string;
  directives?: Directive[];
  directiveRuntime?: RouteScopedDirectiveRuntime;
}): Pick<ProcessTurnInput, "directives" | "directiveMatcher"> => {
  const directiveSteerInput = directiveSteerInputForSession(options.session, options.accountId);
  return {
    directives: options.directives ?? options.directiveRuntime?.directivesFor(directiveSteerInput) ??
      directivesForSession(options.session),
    directiveMatcher: {
      async match({ turn, directives }) {
        const runtime = options.directiveRuntime;
        if (!runtime) {
          return directiveMatchesForSession(options.session);
        }
        const steerInput = directiveSteerInputForSession(options.session, options.accountId, turn);
        const steering = await runtime.matchAndResolve(steerInput, directives);
        options.session.directiveSteering = steering;
        return steering.matches;
      },
    },
  };
};

export const createChatProcessTurnInput = (options: ChatProcessTurnInputOptions): ProcessTurnInput => {
  const directiveWiring = buildDirectiveTurnWiring(options);
  return {
    agent: toConversationAgentConfig(options.session.agent),
    sessionId: options.session.conversation.id,
    inputEvent: toConversationInputEvent(options.session.userMessage),
    skills: options.skills ?? [],
    directives: directiveWiring.directives,
    stores: {
      async loadHistory() {
        return toConversationMessages(options.session.history);
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
    ...(options.routineStore ? { routineStore: options.routineStore } : {}),
    ...(options.routineRunner ? { routineRunner: options.routineRunner } : {}),
    ...(options.routineActivator ? { routineActivator: options.routineActivator } : {}),
  };
};

export const createChatProcessTurnStreamInput = (
  options: ChatProcessTurnStreamInputOptions,
): ProcessTurnStreamInput => ({
  ...createChatProcessTurnInput(options),
  composer: options.composer,
});

export interface AttemptRoutineInputOptions {
  session: PreparedSession;
  accountId?: string;
  directives?: Directive[];
  directiveRuntime?: RouteScopedDirectiveRuntime;
  appendEvent?: (event: ConversationEvent) => Promise<void>;
  routineStore?: ConversationRoutineStore;
  routineRunner?: ConversationRoutineRunner;
  routineActivator?: ConversationRoutineActivator;
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
    inputEvent: toConversationInputEvent(options.session.userMessage),
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
  };
};
