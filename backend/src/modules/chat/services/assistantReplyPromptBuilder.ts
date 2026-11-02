import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RoutinePendingStep, SteeringRule } from "../../../shared/domain/steeringRule.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ChatTurnRoute } from "../../../shared/domain/chatTurnRoute.js";
import { appendRoutineLeadBack, appendSteeringBlock } from "../../../shared/infra/prompts/steeringPromptRenderer.js";
import { renderConversationSummarySection } from "./summary/conversationSummarySection.js";
import type { TurnRouting } from "./turnRouter.js";
import {
  renderPageContextCondition,
  type PageContextCondition,
} from "./pageRead/pageContextCondition.js";

/** What every assistant-voice reply prompt reads from the turn. */
export interface AssistantReplyPromptInput {
  route: ChatTurnRoute;
  responseIdentity?: ResponseIdentity | null;
  answerInstructionBlock: string;
  history: MessageRecord[];
  query: string;
  framing?: TurnRouting["framing"];
  pageContextBlock?: string;
  pageContextCondition?: PageContextCondition | null;
  conversationSummary?: string;
  steering?: SteeringRule[];
  /** The step a routine that yielded this turn still waits on; the reply closes by pointing back to it. */
  pendingRoutineStep?: RoutinePendingStep;
}

/** The answer instructions, visitor context, summary, history, and question every reply prompt carries. */
const turnSectionVariables = (input: AssistantReplyPromptInput): Record<string, string> => {
  const historySection = input.history
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const summarySection = renderConversationSummarySection(input.conversationSummary);
  return {
    answer_instruction_block: input.answerInstructionBlock || "No additional answer instructions.",
    page_context_block: input.pageContextBlock ? `\n${input.pageContextBlock}` : "",
    page_context_condition_block: input.pageContextCondition
      ? `\n${renderPageContextCondition(input.pageContextCondition)}`
      : "",
    conversation_summary_block: summarySection ? `\n${summarySection}\n` : "",
    history_section: historySection || "No prior history",
    query: input.query,
  };
};

/** Closes a reply prompt with the turn's steering and, when a routine yielded the turn, the lead-back to its step. */
const withTurnSteering = (prompt: string, input: AssistantReplyPromptInput): string =>
  appendRoutineLeadBack(appendSteeringBlock(prompt, input.steering), input.steering, input.pendingRoutineStep);

export const buildAssistantReplyPrompt = (input: AssistantReplyPromptInput): string =>
  withTurnSteering(renderPromptTemplate("chat/non-retrieval-answer.md", {
    route_type: input.route,
    identity_status:
      input.framing?.isIdentityQuestion && !input.responseIdentity
        ? "not_configured"
        : "configured_or_not_needed",
    intent_topic: input.framing?.intentTopic || "not provided",
    in_scope_request: input.framing?.inScopeRequest || "none",
    outside_scope_request: input.framing?.outsideScopeRequest || "none",
    ...turnSectionVariables(input),
  }), input);

const SKILL_FINDINGS_TAG = "skill_findings";
// The `<` of anything a model could read as the findings block's own opening or closing tag, in
// any case and spacing. Structural: it matches the frame's tag name, not the skill's vocabulary.
const SKILL_FINDINGS_TAG_START = new RegExp(`<(?=\\s*/?\\s*${SKILL_FINDINGS_TAG}\\b)`, "giu");

/**
 * The text a bound skill returned, framed as data. It keeps its own characters, links and
 * ampersands included, so the reply can carry them over; only a sequence that could close the
 * block or open another is broken up, so the text cannot step outside the frame.
 */
const skillFindingsBlock = (skillFindings: string): string =>
  `<${SKILL_FINDINGS_TAG}>\n${skillFindings.replace(SKILL_FINDINGS_TAG_START, "&lt;")}\n</${SKILL_FINDINGS_TAG}>`;

/**
 * The prompt for a reply the agent writes from what a directive-bound skill returned this turn:
 * the skill's text arrives as findings, and the reply carries the same answer instructions,
 * visitor context, history, steering, and routine lead-back as the direct reply.
 */
export const buildSkillResultReplyPrompt = (input: AssistantReplyPromptInput, skillFindings = ""): string =>
  withTurnSteering(renderPromptTemplate("chat/skill-result-answer.md", {
    ...turnSectionVariables(input),
    skill_findings_block: skillFindingsBlock(skillFindings),
  }), input);
