/**
 * What each per-agent switch is until an operator sets it. Read when an agent's input is
 * normalized, so a stored agent or an imported config without the key reads as this value.
 */
export const AGENT_SWITCH_DEFAULTS = {
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  // Contact requests are opt-in per assistant — off until an operator enables the
  // capability in the assistant's Skills settings.
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
  handoffOnRetrievalMiss: false,
  // Photos are opt-in per assistant: each one is read by the agent's chat model and kept with the conversation.
  visitorImagesEnabled: false,
  // Cards are opt-in per assistant: a live agent's replies look the same until an operator asks for them.
  replyCardsEnabled: false,
} as const;
