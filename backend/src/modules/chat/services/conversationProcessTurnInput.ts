import type {
  ConversationEvent,
  ConversationModelGateway,
  ConversationSkillDispatcher,
  ConversationSkillSelector,
  ConversationTurnComposer,
  Directive,
  DirectiveMatch,
  ProcessTurnInput,
  SkillDefinition,
} from "@radioso/conversation-contract";

import type { PreparedSession } from "./chatSessionPreparer.js";
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
  modelGateway?: ConversationModelGateway;
  appendEvent?: (event: ConversationEvent) => Promise<void>;
}

const directiveMatchesForSession = (session: PreparedSession): DirectiveMatch[] =>
  session.directiveSteering?.matches ?? [];

const directivesForSession = (session: PreparedSession): Directive[] =>
  directiveMatchesForSession(session).map((match) => match.directive);

export const createChatProcessTurnInput = (options: ChatProcessTurnInputOptions): ProcessTurnInput => ({
  agent: toConversationAgentConfig(options.session.agent),
  sessionId: options.session.conversation.id,
  inputEvent: toConversationInputEvent(options.session.userMessage),
  skills: options.skills ?? [],
  directives: options.directives ?? directivesForSession(options.session),
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
    async match() {
      return directiveMatchesForSession(options.session);
    },
  },
});
