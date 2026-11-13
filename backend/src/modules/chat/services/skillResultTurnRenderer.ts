import { isDeepStrictEqual } from "node:util";

import { AGENT_SKILL_OUTCOME_KIND, hasAnswerText } from "./agentSkillTurnSkillProvider.js";
import type { AssistantReplyComposer, AssistantReplyConfig } from "./assistantReplyComposer.js";
import { buildSkillResultReplyPrompt } from "./assistantReplyPromptBuilder.js";
import type { ChatPresentedAnswer } from "./chatAnswerPresenter.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { estimateTextGenerationInputTokens } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { TurnOutcome, TurnOutcomeRenderer, TurnRenderContext, TurnStreamResult } from "./turnOutcome.js";
import type { SkillResultCardsOffer, SkillResultReplyBlocks } from "./replyBlocks/skillResultReplyBlocks.js";
import { hasToolRecords, ToolRecordLedger } from "./replyBlocks/toolRecords.js";

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
  /** Offers the `present` head over a skill's records; without it, records reach the reply as text only. */
  replyBlocks?: Pick<SkillResultReplyBlocks, "offerFor">;
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
  maxInputTokens: number = CHAT_BEHAVIOR.skillResult.maxFindingsInputTokens,
): string => {
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
 * Whether the skill's text is only the JSON form of its structured content, as an MCP tool often
 * returns beside it. Structural: the text is parsed and compared deeply, never matched as words.
 */
const duplicatesStructuredContent = (text: string, outputs: Record<string, unknown> | undefined): boolean => {
  if (!outputs) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const keys = Object.keys(outputs);
  const structured = keys.length === 1 && keys[0] === "structuredContent" ? outputs.structuredContent : outputs;
  return isDeepStrictEqual(parsed, structured);
};

/** What one skill-result reply is written from: its findings, and the `present` offer when there is one. */
interface SkillResultReplyInput {
  findings: string;
  offer: SkillResultCardsOffer | null;
}

/**
 * Renders a completed agent-skill outcome as the agent's own reply. The agent's model
 * writes it from what the skill returned, read as findings (data, never instructions),
 * in the agent's voice with its answer instructions and directives applied, so a tool's
 * raw output stays out of the visitor's reply. Selected by outcome kind, never by skill
 * name. A failed, suppressed, or empty outcome is left to the generic renderer.
 *
 * The findings are the skill's text. Where the reply may show cards and the skill returned
 * records, they are the records first, under their handles and within their own budget, then
 * the text unless it only repeats the records, and the reply is offered the `present` head.
 * When the model named cards none of which could be built, a whole reply is written again from
 * the records without handles or cards, so its lead never promises a list that is not there; a
 * streamed reply has already gone out, so the loss is only logged and counted.
 */
export const createSkillResultTurnRenderer = (
  composer: AssistantReplyComposer,
  options: SkillResultTurnRendererOptions = {},
): TurnOutcomeRenderer => {
  const findingsWith = (outcome: TurnOutcome, ctx: TurnRenderContext, records: string): string => {
    const ids = {
      skillName: outcome.skillName,
      workspaceId: ctx.session.agent.workspaceId,
      conversationId: ctx.session.conversation.id,
    };
    const text = outcome.outcome.answer ?? "";
    if (!records) {
      return cappedSkillFindings(text, ids, options.logger);
    }
    const own = duplicatesStructuredContent(text, outcome.outcome.outputs) ? "" : text.trim();
    if (!own) {
      return records;
    }
    const remaining = CHAT_BEHAVIOR.skillResult.maxFindingsInputTokens - estimateTextGenerationInputTokens({ prompt: records });
    return `${records}\n\n${cappedSkillFindings(own, ids, options.logger, remaining)}`;
  };

  // A routine step that shows the results (#1763) is written from the records whether or not its
  // cards are shown: without cards, the reply lists them in text.
  const prepare = (outcome: TurnOutcome, ctx: TurnRenderContext): SkillResultReplyInput => {
    const outputs = outcome.outcome.outputs;
    const offer = options.replyBlocks?.offerFor(ctx.session, outcome.skillName, outputs, ctx.presentBinding) ?? null;
    const plainRecords = ctx.presentBinding && !offer ? ToolRecordLedger.fromOutputs(outputs).promptSection({ handles: false }) : "";
    return { findings: findingsWith(outcome, ctx, offer?.records.withHandles ?? plainRecords), offer };
  };

  return {
    supports: (outcome) =>
      outcome.kind === AGENT_SKILL_OUTCOME_KIND
      && outcome.outcome.status === "completed"
      && (hasAnswerText(outcome.outcome.answer) || hasToolRecords(outcome.outcome.outputs)),
    render: async (outcome, ctx) => {
      const { findings, offer } = prepare(outcome, ctx);
      const compose = (text: string, withOffer: SkillResultCardsOffer | null) =>
        composer.composeAnswer(ctx.session, ctx.query, ctx.userExpectedLocale, ctx.accountId, text, withOffer);
      const presentation = await compose(findings, offer);
      return presentedAsBoundSkill(
        outcome,
        offer?.cardsLost() ? await compose(findingsWith(outcome, ctx, offer.records.plain), null) : presentation,
      );
    },
    async *stream(outcome, ctx): AsyncGenerator<string, TurnStreamResult> {
      const { findings, offer } = prepare(outcome, ctx);
      const result = yield* composer.streamAnswer(
        ctx.session,
        ctx.query,
        ctx.userExpectedLocale,
        ctx.accountId,
        ctx.signal,
        findings,
        offer,
      );
      return { ...result, finalPresentation: presentedAsBoundSkill(outcome, result.finalPresentation) };
    },
  };
};
