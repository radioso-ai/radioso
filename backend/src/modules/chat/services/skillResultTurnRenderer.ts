import { AGENT_SKILL_OUTCOME_KIND, hasAnswerText } from "./agentSkillTurnSkillProvider.js";
import type { AssistantReplyComposer, AssistantReplyConfig } from "./assistantReplyComposer.js";
import { buildSkillResultReplyPrompt } from "./assistantReplyPromptBuilder.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { estimateTextGenerationInputTokens } from "../../../shared/infra/llm/modelInferencePipeline.js";
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

/**
 * The bound skill's name and settled status: the identity the turn records, so Quality and
 * the skill columns read a skill-result reply the way they read any bound skill's turn.
 * `answerOutcome` stays unset, as it was when bound skills rendered verbatim: the composer
 * tags `non_retrieval_response`, which connector grounding would read as "not applicable".
 */
const presentedAsBoundSkill = (outcome: TurnOutcome, presentation: ChatPresentedAnswer): ChatPresentedAnswer => ({
  ...presentation,
  skillName: outcome.skillName,
  skillOutcome: outcome.outcome.status,
  skillStatus: outcome.outcome.status,
  answerOutcome: undefined,
});

interface SkillResultTurnRendererOptions {
  logger?: Pick<AppLogger, "warn">;
}

interface SkillResultFindingsIds {
  skillName: string;
  workspaceId: string;
  conversationId: string;
}

/**
 * Bounds a directive-bound skill's returned text before it enters the reply prompt, in the
 * input-token estimate the pre-call budget guard uses, so findings in any script cannot
 * overflow the model's input after the tool has already run. A UTF-16 length within the
 * budget always estimates within it, so ordinary results skip the walk; an over-budget one is
 * cut on a code-point boundary to the longest prefix that fits. A cut logs ids and sizes only.
 */
export const cappedSkillFindings = (
  findings: string,
  ids: SkillResultFindingsIds,
  logger?: Pick<AppLogger, "warn">,
): string => {
  const maxInputTokens = CHAT_BEHAVIOR.skillResult.maxFindingsInputTokens;
  if (findings.length <= maxInputTokens) {
    return findings;
  }
  if (estimateTextGenerationInputTokens({ prompt: findings }) <= maxInputTokens) {
    return findings;
  }

  const codePoints = Array.from(findings);
  const fitsWithin = (count: number): boolean =>
    estimateTextGenerationInputTokens({ prompt: codePoints.slice(0, count).join("") }) <= maxInputTokens;

  let lower = 0;
  let upper = codePoints.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (fitsWithin(middle)) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  const truncated = codePoints.slice(0, lower).join("");
  logger?.warn(
    {
      event: "chat.skill_result.findings_truncated",
      skillName: ids.skillName,
      workspaceId: ids.workspaceId,
      conversationId: ids.conversationId,
      originalCodePoints: codePoints.length,
      truncatedCodePoints: lower,
      maxInputTokens,
    },
    "Skill result findings truncated before entering the reply prompt",
  );
  return truncated;
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
      && hasAnswerText(outcome.outcome.answer),
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
