import type { NormalizedAgentInput } from "../../modules/agents/public.js";

/**
 * The `behavior_settings` column an agent's row stores: its answer switches, the contact
 * delivery, and the look and voice blocks. Written whole on every save.
 */
export const toBehaviorSettings = (agent: NormalizedAgentInput): Record<string, unknown> => ({
  customInstruction: agent.customInstruction,
  suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
  assistantLinkUtmEnabled: agent.assistantLinkUtmEnabled,
  citationDisplayEnabled: agent.citationDisplayEnabled,
  contactRequestsEnabled: agent.contactRequestsEnabled,
  webhookExportsEnabled: agent.webhookExportsEnabled,
  handoffOnRetrievalMiss: agent.handoffOnRetrievalMiss,
  visitorImagesEnabled: agent.visitorImagesEnabled,
  replyCardsEnabled: agent.replyCardsEnabled,
  contactRequestDelivery: agent.contactRequestDelivery,
  logo: agent.logo,
  theme: agent.theme,
  branding: agent.branding,
  voice: agent.voice,
  mechanicsReplies: agent.mechanicsReplies,
});
