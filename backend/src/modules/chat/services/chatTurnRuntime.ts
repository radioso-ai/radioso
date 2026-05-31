import type { ChatGateway } from "../contracts/chatGateway.js";
import { AssistantSuggestionExpansionService } from "./assistantSuggestionExpansionService.js";
import { ChatAnswerSupport } from "./chatAnswerSupport.js";
import {
  ChatAnswerPresenter,
  type SkillOutcomeCapabilityProvider,
} from "./chatAnswerPresenter.js";
import type { ChatActionSuggestionService } from "./actionSuggestions/chatActionSuggestionService.js";
import type { FallbackReplyComposer } from "./fallbackReplyComposer.js";
import type { TurnSkill } from "./turnOutcome.js";
import { RetrievalAnswerComposer, createRetrievalTurnSkill } from "./retrievalTurnSkill.js";
import { SocialAnswerComposer, createSocialTurnSkill } from "./socialTurnSkill.js";
import {
  AssistantIdentityAnswerComposer,
  createAssistantIdentityTurnSkill,
} from "./assistantIdentityTurnSkill.js";

export interface ChatTurnRuntimeDependencies {
  chatGateway: ChatGateway;
  fallbackReplyComposer: FallbackReplyComposer;
  chatActionSuggestionService?: ChatActionSuggestionService;
  skillOutcomeCapabilities: SkillOutcomeCapabilityProvider;
}

/**
 * The assembled per-turn collaborators a chat host needs to answer: the answer
 * support helpers, the answer presenter, and the registered terminal-answer
 * skills. Built once and handed to the host; the host never re-assembles it.
 */
export interface ChatTurnRuntime {
  answerSupport: ChatAnswerSupport;
  chatAnswerPresenter: ChatAnswerPresenter;
  turnSkills: TurnSkill[];
}

/**
 * Assembles the chat module's turn runtime. Composition supplies the external
 * collaborators (gateway, fallback composer, suggestion service, capability
 * provider); this factory owns which terminal-answer capabilities exist
 * (retrieval, social, identity) and how their composers are wired. Adding a
 * capability is a registration here, not a branch in the host's turn loop — the
 * host receives `turnSkills` and selects among them by route.
 */
export const buildChatTurnRuntime = (
  deps: ChatTurnRuntimeDependencies,
): ChatTurnRuntime => {
  const answerSupport = new ChatAnswerSupport();
  const chatAnswerPresenter = new ChatAnswerPresenter(
    new AssistantSuggestionExpansionService(),
    deps.chatActionSuggestionService,
    deps.skillOutcomeCapabilities,
  );
  const turnSkills: TurnSkill[] = [
    createRetrievalTurnSkill(
      new RetrievalAnswerComposer(
        answerSupport,
        deps.chatGateway,
        chatAnswerPresenter,
        deps.fallbackReplyComposer,
      ),
    ),
    createSocialTurnSkill(
      new SocialAnswerComposer(
        answerSupport,
        deps.chatGateway,
        chatAnswerPresenter,
        deps.fallbackReplyComposer,
      ),
    ),
    createAssistantIdentityTurnSkill(
      new AssistantIdentityAnswerComposer(
        answerSupport,
        deps.chatGateway,
        chatAnswerPresenter,
        deps.fallbackReplyComposer,
      ),
    ),
  ];
  return { answerSupport, chatAnswerPresenter, turnSkills };
};
