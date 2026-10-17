import type { PreparedSession } from "./chatSessionPreparer.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { buildPreparedTurnOutcome } from "./preparedTurnOutcome.js";
import { builtInAnswerSkills } from "./builtInAnswerSkills.js";
import type { AssistantReplyComposer, AssistantReplyConfig } from "./assistantReplyComposer.js";
import type { ChatAnswerPresenter, ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import type { TurnOutcome, TurnRenderContext, TurnSkill, TurnStreamResult } from "./turnOutcome.js";
import {
  decideQuickReply,
  plannerReplySourceMetadata,
  plannerReplySourceOf,
  type QuickReplyDecision,
  type UsableQuickReply,
} from "./turnPlanQuickReply.js";

/** The outcome kind (chat-side renderer tag) and the canonical skill identity. */
const DIRECT_OUTCOME_KIND = "direct";
const DIRECT_TURN_SKILL = builtInAnswerSkills.direct;

/** Direct is an assistant-voice reply without retrieval. */
export const DIRECT_REPLY_CONFIG: AssistantReplyConfig = {
  skillName: DIRECT_TURN_SKILL,
  outcomeKind: DIRECT_OUTCOME_KIND,
};

/** What the direct skill needs besides its composer to send a planner-written reply. */
interface DirectTurnSkillQuickReplyPorts {
  presenter: ChatAnswerPresenter;
  logger?: Pick<AppLogger, "debug">;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  /** Composition's kill switch (default true): false, every direct turn is composed. */
  quickReplyLaneEnabled?: boolean;
}

const buildDirectTurnOutcome = (session: PreparedSession): TurnOutcome =>
  buildPreparedTurnOutcome(session, { kind: DIRECT_OUTCOME_KIND, skillName: DIRECT_TURN_SKILL });

/** A direct outcome already settled with the planner's words: rendering makes no model call. */
const buildQuickReplyOutcome = (session: PreparedSession, quickReply: UsableQuickReply): TurnOutcome => ({
  ...buildDirectTurnOutcome(session),
  outcome: {
    status: "completed",
    answer: quickReply.text,
    metadata: plannerReplySourceMetadata(quickReply.kind, quickReply.wording),
  },
});

/** Counts and logs the lane's decisions; the reply's words never reach a log. */
const observeQuickReplyDecision = (
  decision: QuickReplyDecision,
  session: PreparedSession,
  ports: DirectTurnSkillQuickReplyPorts,
): void => {
  const context = { agentId: session.agent.id, conversationId: session.conversation.id };
  if (decision.kind === "use") {
    ports.metrics?.incrementCounter("chat_turn_quick_reply_total", {
      help: "Direct turns answered by the quick-reply lane, by conversational mechanic and whose words it sent.",
      labels: { kind: decision.quickReply.kind, wording: decision.quickReply.wording },
    });
    ports.logger?.debug(
      {
        ...context,
        kind: decision.quickReply.kind,
        wording: decision.quickReply.wording,
        textLength: decision.quickReply.text.length,
      },
      "chat.turn.quick_reply",
    );
  } else if (decision.kind === "skip") {
    ports.logger?.debug({ ...context, kind: decision.plannedKind, reason: decision.reason }, "chat.turn.quick_reply_skipped");
  }
};

/**
 * Registers the direct answer as a terminal `TurnSkill`, selected for direct turns.
 * When the turn planner already wrote the reply and `decideQuickReply` lets the turn
 * use it, dispatch settles the outcome with those words and rendering presents them
 * as committed text; otherwise the composer writes the reply.
 */
export const createDirectTurnSkill = (
  composer: AssistantReplyComposer,
  quickReplyPorts: DirectTurnSkillQuickReplyPorts,
): TurnSkill => {
  const presentQuickReply = (outcome: TurnOutcome): ChatPresentedAnswer | null => {
    const replySource = plannerReplySourceOf(outcome.outcome.metadata);
    const answer = outcome.outcome.answer;
    if (!replySource || !answer) {
      return null;
    }
    return {
      ...quickReplyPorts.presenter.presentNonRetrievalAnswer(answer, {
        skillName: DIRECT_TURN_SKILL,
        outcome: DIRECT_OUTCOME_KIND,
        status: "completed",
      }),
      metadata: plannerReplySourceMetadata(replySource.quickReplyKind, replySource.quickReplyWording),
    };
  };
  return {
    definition: { name: DIRECT_TURN_SKILL, outcomeKinds: [DIRECT_OUTCOME_KIND] },
    selects: (session) => session.turnRoute === CHAT_TURN_ROUTE.DIRECT,
    dispatch: async (session) => {
      if (quickReplyPorts.quickReplyLaneEnabled === false) {
        return buildDirectTurnOutcome(session);
      }
      const decision = await decideQuickReply(session);
      observeQuickReplyDecision(decision, session, quickReplyPorts);
      return decision.kind === "use"
        ? buildQuickReplyOutcome(session, decision.quickReply)
        : buildDirectTurnOutcome(session);
    },
    renderer: {
      supports: (outcome) => outcome.kind === DIRECT_OUTCOME_KIND,
      render: async (outcome, ctx: TurnRenderContext) =>
        presentQuickReply(outcome)
          ?? composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId),
      async *stream(outcome, ctx: TurnRenderContext): AsyncGenerator<string, TurnStreamResult> {
        const quickReply = presentQuickReply(outcome);
        if (quickReply) {
          // Whole text, nothing streamed live: the host delivers it as committed chunks.
          return {
            finalPresentation: quickReply,
            suggestions: { mode: "presentation" },
            hasStreamedAnswer: false,
            streamedAnswer: "",
            deliveryMode: "committed",
          };
        }
        return yield* composer.streamAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId, ctx.signal);
      },
    },
  };
};
