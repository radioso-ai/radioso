import type {
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

const missingModelGateway: ConversationModelGateway = {
  async complete(): Promise<{ text: string }> {
    throw new Error("conversation_model_gateway_not_configured");
  },
};

export interface ChatProcessTurnInputOptions {
  session: PreparedSession;
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

const directiveSteerInputForSession = (
  session: PreparedSession,
  turn?: Pick<TurnContext, "inputEvent">,
) => ({
  workspaceId: session.agent.workspaceId,
  turnContext: {
    query: turn?.inputEvent.content ?? session.userMessage.content,
    route: session.turnRoute,
  },
});

export const createChatProcessTurnInput = (options: ChatProcessTurnInputOptions): ProcessTurnInput => {
  const directiveSteerInput = directiveSteerInputForSession(options.session);
  return {
    agent: toConversationAgentConfig(options.session.agent),
    sessionId: options.session.conversation.id,
    inputEvent: toConversationInputEvent(options.session.userMessage),
    skills: options.skills ?? [],
    directives: options.directives ?? options.directiveRuntime?.directivesFor(directiveSteerInput) ??
      directivesForSession(options.session),
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
    directiveMatcher: {
      async match({ turn, directives }) {
        const runtime = options.directiveRuntime;
        if (!runtime) {
          return directiveMatchesForSession(options.session);
        }
        const steerInput = directiveSteerInputForSession(options.session, turn);
        const matches = await runtime.matcher.match({
          turnContext: steerInput.turnContext,
          directives,
        });
        const steering = await runtime.resolveMatches(steerInput, matches);
        options.session.directiveSteering = steering;
        return steering.matches;
      },
    },
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
