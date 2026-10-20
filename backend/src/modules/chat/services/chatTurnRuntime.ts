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
import {
  createDirectiveAdherenceSideChannel,
  type DirectiveAdherenceTally,
} from "../../../shared/domain/directiveAdherence.js";

export interface ChatTurnRuntimeDependencies {
  chatGateway: ChatGateway;
  fallbackReplyComposer: FallbackReplyComposer;
  chatActionSuggestionService?: ChatActionSuggestionService;
  skillOutcomeCapabilities: SkillOutcomeCapabilityProvider;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  logger?: Pick<AppLogger, "debug">;
  /** Composition's quick-reply kill switch (default true): false, every direct turn is composed. */
  quickReplyLaneEnabled?: boolean;
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

const DIRECTIVE_ADHERENCE_VERDICT_LABELS: Record<keyof DirectiveAdherenceTally, string> = {
  satisfied: "satisfied",
  unsatisfied: "unsatisfied",
  notApplicable: "not_applicable",
  ungraded: "ungraded",
};

/**
 * One count per rendered directive rule per grounded answer, by the answer's own
 * verdict: `ungraded` is a rule the answer was shown and returned no grade for
 * (#1575). The verdict is the only label, so the series stays four wide.
 */
const recordDirectiveAdherenceTally = (
  metrics: ChatTurnRuntimeDependencies["metrics"],
  tally: DirectiveAdherenceTally,
): void => {
  for (const [key, verdict] of Object.entries(DIRECTIVE_ADHERENCE_VERDICT_LABELS) as Array<[keyof DirectiveAdherenceTally, string]>) {
    if (tally[key] > 0) {
      metrics?.incrementCounter("chat_directive_adherence_verdicts_total", {
        help: "Directive rules rendered into grounded answers, by the answer's own adherence verdict",
        labels: { verdict },
        value: tally[key],
      });
    }
  }
};

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
    deps.metrics,
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
        {
          forSteeringRules: (rules) => createDirectiveAdherenceSideChannel(rules, {
            ...(deps.logger ? { logger: deps.logger } : {}),
            onTally: (tally) => recordDirectiveAdherenceTally(deps.metrics, tally),
          }),
        },
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
      {
        presenter: chatAnswerPresenter,
        logger: deps.logger,
        metrics: deps.metrics,
        quickReplyLaneEnabled: deps.quickReplyLaneEnabled ?? true,
      },
    ),
  ];
  return {
    chatAnswerPresenter,
    turnSkills,
    metrics: deps.metrics,
  };
};
