import type {
  ConversationMessage,
  ConversationModelGateway,
  TurnContext,
} from "@radioso/conversation-contract";

import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import { extractFirstJsonObject } from "./jsonScan.js";

const ACTIVATION_PROMPT = "chat/routine-contact-activation.md";

const turnMessages = (turn: TurnContext): ConversationMessage[] => [
  ...turn.history,
  { role: "user", content: turn.inputEvent.content },
];

const parseWantsContact = (raw: string): boolean => {
  const json = extractFirstJsonObject(raw.trim());
  if (!json) {
    return false;
  }
  try {
    const parsed = JSON.parse(json) as { wantsContact?: unknown };
    return parsed.wantsContact === true;
  } catch {
    return false;
  }
};

/**
 * Decides whether the user's latest message expresses wanting a human to follow up —
 * the natural-language trigger for the contact routine (the explicit pill click is the
 * other, faster trigger). It's an LLM-classified judgement (multilingual, no keyword
 * lists); the prompt lives under `backend/prompts/`. A classification failure declines
 * (returns false) so a model error never derails the turn or starts the flow spuriously.
 */
export const classifyContactIntent = async (
  modelGateway: ConversationModelGateway,
  turn: TurnContext,
): Promise<boolean> => {
  try {
    const systemPrompt = renderPromptTemplate(ACTIVATION_PROMPT, {});
    const { text } = await modelGateway.complete({ messages: turnMessages(turn), systemPrompt });
    return parseWantsContact(text);
  } catch {
    return false;
  }
};
