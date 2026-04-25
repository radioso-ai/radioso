import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { AssistantIdentityPromptInput } from "../../settings/domain/assistantBootstrapSettings.js";
import type { ChatTurnRoute } from "./chatTurnIntentService.js";
import { CHAT_TURN_ROUTE } from "./chatTurnIntentService.js";

export const buildNonRetrievalAnswerPrompt = (input: {
  route: ChatTurnRoute;
  assistantIdentity?: AssistantIdentityPromptInput | null;
  answerInstructionBlock: string;
  history: MessageRecord[];
  query: string;
}): string => {
  const historySection = input.history
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const identityAvailabilityInstruction =
    input.route === CHAT_TURN_ROUTE.ASSISTANT_IDENTITY && !input.assistantIdentity
      ? loadPromptTemplate("chat/assistant-identity-missing-guidance.md").trim()
      : "";
  const answerInstructionBlock = [
    identityAvailabilityInstruction,
    input.answerInstructionBlock,
  ]
    .filter((block) => block.trim().length > 0)
    .join("\n\n");

  return renderPromptTemplate(
    input.route === CHAT_TURN_ROUTE.ASSISTANT_IDENTITY
      ? "chat/assistant-identity-answer.md"
      : "chat/social-turn-answer.md",
    {
      answer_instruction_block: answerInstructionBlock || "No additional answer instructions.",
      history_section: historySection || "No prior history",
      query: input.query,
    },
  );
};
