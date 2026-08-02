import type { ConversationInteractionRole } from "@radioso/conversation-contract";

export const MAX_CONVERSATION_SEMANTIC_INTENTS = 4;
export const MAX_CONVERSATION_SEMANTIC_INTENT_ID_LENGTH = 128;
export const MAX_CONVERSATION_SEMANTIC_TEXT_LENGTH = 4_000;

const semanticIntentIdPattern = /^[A-Za-z0-9_.:-]+$/;

export interface ConversationSemanticIntentValue {
  id: string;
  text: string;
}

export const conversationInteractionRoleCarriesIntents = (
  role: ConversationInteractionRole,
): boolean => role === "substantive_new"
  || role === "substantive_followup"
  || role === "clarification_value";

export const isValidConversationSemanticIntent = (
  intent: ConversationSemanticIntentValue,
): boolean => intent.id.length >= 1
  && intent.id.length <= MAX_CONVERSATION_SEMANTIC_INTENT_ID_LENGTH
  && semanticIntentIdPattern.test(intent.id)
  && intent.text.trim().length >= 1
  && intent.text.length <= MAX_CONVERSATION_SEMANTIC_TEXT_LENGTH;

/**
 * Produces metadata that can be read back without truncation or hash ambiguity.
 * Invalid values are discarded; a substantive role without a surviving semantic
 * intent becomes unresolved instead of persisting a misleading empty envelope.
 */
export const normalizeConversationInteractionMetadata = (input: {
  role: ConversationInteractionRole;
  semanticIntents: readonly ConversationSemanticIntentValue[];
}): { role: ConversationInteractionRole; semanticIntents: ConversationSemanticIntentValue[] } => {
  if (!conversationInteractionRoleCarriesIntents(input.role)) {
    return { role: input.role, semanticIntents: [] };
  }
  const ids = new Set<string>();
  const texts = new Set<string>();
  const semanticIntents: ConversationSemanticIntentValue[] = [];
  for (const intent of input.semanticIntents) {
    if (!isValidConversationSemanticIntent(intent) || ids.has(intent.id) || texts.has(intent.text)) {
      continue;
    }
    ids.add(intent.id);
    texts.add(intent.text);
    semanticIntents.push({ id: intent.id, text: intent.text });
    if (semanticIntents.length === MAX_CONVERSATION_SEMANTIC_INTENTS) {
      break;
    }
  }
  return semanticIntents.length > 0
    ? { role: input.role, semanticIntents }
    : { role: "unresolved", semanticIntents: [] };
};
