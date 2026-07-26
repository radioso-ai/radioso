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
import { AssistantReplyComposer } from "./assistantReplyComposer.js";
import { RetrievalAnswerComposer, createRetrievalTurnSkill } from "./retrievalTurnSkill.js";
import { DIRECT_REPLY_CONFIG, createDirectTurnSkill } from "./directTurnSkill.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { CONTEXT_VARIABLES_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { createDirectiveAdherenceSideChannel } from "../../../shared/domain/directiveAdherence.js";

export interface ChatTurnRuntimeDependencies {
  chatGateway: ChatGateway;
  fallbackReplyComposer: FallbackReplyComposer;
  chatActionSuggestionService?: ChatActionSuggestionService;
  skillOutcomeCapabilities: SkillOutcomeCapabilityProvider;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  logger?: Pick<AppLogger, "debug">;
}

/**
 * The per-turn collaborators a chat host consumes to answer: the answer presenter
 * (it owns suggestion expansion) and the registered terminal-answer skills. Built
 * once and handed to the host; the host never re-assembles it. Each skill owns its
 * own generation, presentation, and grounded-miss reconcile, so the host needs
 * neither the answer-support helpers nor the fallback composer the skills are wired
 * with — those stay internal to this factory.
 */
export interface ChatTurnRuntime {
  chatAnswerPresenter: ChatAnswerPresenter;
  turnSkills: TurnSkill[];
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
}

/**
 * Assembles the chat module's turn runtime. Composition supplies the external
 * collaborators (gateway, fallback composer, suggestion service, capability
 * provider); this factory owns which terminal-answer capabilities exist
 * (retrieval, direct) and how their composers are wired. Adding a
 * capability is a registration here, not a branch in the host's turn loop — the
 * host receives `turnSkills` and selects among them by route.
 */
export const buildChatTurnRuntime = (
  deps: ChatTurnRuntimeDependencies,
): ChatTurnRuntime => {
  const answerSupport = new ChatAnswerSupport(CONTEXT_VARIABLES_BEHAVIOR.renderBound, deps.logger);
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
        deps.metrics,
        // Directive adherence is wired in here, at composition — the composer only
        // sees the capability-neutral side-channel port, never the directive domain.
        { forSteeringRules: (rules) => createDirectiveAdherenceSideChannel(rules, deps.logger) },
      ),
    ),
    createDirectTurnSkill(
      new AssistantReplyComposer(
        answerSupport,
        deps.chatGateway,
        chatAnswerPresenter,
        deps.fallbackReplyComposer,
        DIRECT_REPLY_CONFIG,
      ),
    ),
  ];
  return {
    chatAnswerPresenter,
    turnSkills,
    metrics: deps.metrics,
  };
};
