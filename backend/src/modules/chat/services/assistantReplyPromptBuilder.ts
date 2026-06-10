import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { SteeringRule } from "../../../shared/domain/steeringRule.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ChatTurnRoute } from "../../../shared/domain/chatTurnRoute.js";
import { appendSteeringBlock } from "../../../shared/infra/prompts/steeringPromptRenderer.js";
import type { TurnRouting } from "./turnRouter.js";

export const buildAssistantReplyPrompt = (input: {
  route: ChatTurnRoute;
  responseIdentity?: ResponseIdentity | null;
  answerInstructionBlock: string;
  history: MessageRecord[];
  query: string;
  framing?: TurnRouting["framing"];
  pageContextBlock?: string;
  steering?: SteeringRule[];
}): string => {
  const historySection = input.history
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const prompt = renderPromptTemplate("chat/non-retrieval-answer.md", {
    route_type: input.route,
    identity_status:
      input.framing?.isIdentityQuestion && !input.responseIdentity
        ? "not_configured"
        : "configured_or_not_needed",
    intent_topic: input.framing?.intentTopic || "not provided",
    in_scope_request: input.framing?.inScopeRequest || "none",
    outside_scope_request: input.framing?.outsideScopeRequest || "none",
    answer_instruction_block: input.answerInstructionBlock || "No additional answer instructions.",
    page_context_block: input.pageContextBlock ? `\n${input.pageContextBlock}` : "",
    history_section: historySection || "No prior history",
    query: input.query,
  });
  return appendSteeringBlock(prompt, input.steering);
};
