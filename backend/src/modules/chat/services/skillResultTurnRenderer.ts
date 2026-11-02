import { AGENT_SKILL_OUTCOME_KIND } from "./agentSkillTurnSkillProvider.js";
import type { AssistantReplyComposer, AssistantReplyConfig } from "./assistantReplyComposer.js";
import { buildSkillResultReplyPrompt } from "./assistantReplyPromptBuilder.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { TurnOutcome, TurnOutcomeRenderer, TurnRenderContext, TurnStreamResult } from "./turnOutcome.js";

/**
 * A reply the agent writes from a directive-bound skill's result. The outcome kind seeds
 * its usage attempt keys (`skill_result`, `stream_skill_result`, and their `_miss`
 * declines). The composer tags its presentation with this capability; the renderer
 * presents the reply under the bound skill it answers for.
 */
export const SKILL_RESULT_REPLY_CONFIG: AssistantReplyConfig = {
  skillName: AGENT_SKILL_OUTCOME_KIND,
  outcomeKind: "skill_result",
  buildPrompt: buildSkillResultReplyPrompt,
};

const hasFindings = (answer: string | undefined): answer is string =>
  typeof answer === "string" && answer.trim().length > 0;

/**
 * The bound skill's name and settled status: the identity the turn records, so Quality and
 * the skill columns read a skill-result reply the way they read any bound skill's turn.
 */
const presentedAsBoundSkill = (outcome: TurnOutcome, presentation: ChatPresentedAnswer): ChatPresentedAnswer => ({
  ...presentation,
  skillName: outcome.skillName,
  skillOutcome: outcome.outcome.status,
  skillStatus: outcome.outcome.status,
});

interface SkillResultTurnRendererOptions {
  logger?: Pick<AppLogger, "debug">;
}

interface SkillResultFindingsIds {
  skillName: string;
  workspaceId: string;
  conversationId: string;
}

/**
 * Caps a directive-bound skill's returned text before it enters the reply prompt
 * (`CHAT_BEHAVIOR.skillResult.maxFindingsCodePoints`). Put in whole, a huge MCP result could
 * overflow the model's input and fail the turn after the tool has already run. Cut on a
 * Unicode code-point boundary — `Array.from` iterates a string by code point, so a surrogate
 * pair is never split — never by UTF-16 code unit. A cut emits one structured log line with
 * ids and sizes only; the findings text never reaches the log.
 */
export const cappedSkillFindings = (
  findings: string,
  ids: SkillResultFindingsIds,
  logger?: Pick<AppLogger, "debug">,
): string => {
  const cap = CHAT_BEHAVIOR.skillResult.maxFindingsCodePoints;
  const codePoints = Array.from(findings);
  if (codePoints.length <= cap) {
    return findings;
  }
  logger?.debug(
    {
      event: "chat.skill_result.findings_truncated",
      skillName: ids.skillName,
      workspaceId: ids.workspaceId,
      conversationId: ids.conversationId,
      originalCodePoints: codePoints.length,
      cap,
    },
    "Skill result findings truncated before entering the reply prompt",
  );
  return codePoints.slice(0, cap).join("");
};

/**
 * Renders a completed agent-skill outcome as the agent's own reply. The agent's model
 * writes it from the text the skill returned, read as findings (data, never instructions),
 * in the agent's voice with its answer instructions and directives applied, so a tool's
 * raw output stays out of the visitor's reply. Selected by outcome kind, never by skill
 * name. A failed, suppressed, or empty outcome is left to the generic renderer.
 */
export const createSkillResultTurnRenderer = (
  composer: AssistantReplyComposer,
  options: SkillResultTurnRendererOptions = {},
): TurnOutcomeRenderer => {
  const findingsFor = (outcome: TurnOutcome, ctx: TurnRenderContext): string =>
    cappedSkillFindings(
      outcome.outcome.answer ?? "",
      {
        skillName: outcome.skillName,
        workspaceId: ctx.session.agent.workspaceId,
        conversationId: ctx.session.conversation.id,
      },
      options.logger,
    );

  return {
    supports: (outcome) =>
      outcome.kind === AGENT_SKILL_OUTCOME_KIND
      && outcome.outcome.status === "completed"
      && hasFindings(outcome.outcome.answer),
    render: async (outcome, ctx) => presentedAsBoundSkill(
      outcome,
      await composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId, findingsFor(outcome, ctx)),
    ),
    async *stream(outcome, ctx): AsyncGenerator<string, TurnStreamResult> {
      const result = yield* composer.streamAnswer(
        ctx.session,
        ctx.query,
        ctx.userExpectedLocale,
        ctx.accountId,
        ctx.signal,
        findingsFor(outcome, ctx),
      );
      return { ...result, finalPresentation: presentedAsBoundSkill(outcome, result.finalPresentation) };
    },
  };
};
