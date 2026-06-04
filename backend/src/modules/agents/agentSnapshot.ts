import type {
  AgentChatModelOverride,
  AgentSourceScope,
  ConversationAgent,
} from "./domain.js";

/**
 * Immutable, point-in-time copy of the agent fields that influence chat
 * behavior. Has no timestamps and no surface settings (those are display
 * concerns and not part of "how the agent answered"). Use this anywhere
 * you need to record "the agent configuration that was in effect at moment
 * X" — eval replay, per-message agent persistence, audit trails — without
 * depending on the live agent row staying the same.
 *
 * Lives here in the agents module because the agent record is owned here.
 * Consumers MUST NOT redefine this shape inside their own modules.
 */
export interface AgentSnapshot {
  agentId: string;
  name: string;
  customInstruction: string;
  greetingInstruction: string;
  assistantDefaultLocale: string | null;
  retrievalEnabled: boolean;
  suggestedQuestionsEnabled: boolean;
  citationDisplayEnabled: boolean;
  sourceScope: AgentSourceScope;
  skillSettings: Record<string, unknown>;
  chatModelOverride: AgentChatModelOverride | null;
}

export const freezeAgent = (agent: ConversationAgent): AgentSnapshot => ({
  agentId: agent.id,
  name: agent.name,
  customInstruction: agent.customInstruction,
  greetingInstruction: agent.greetingInstruction,
  assistantDefaultLocale: agent.assistantDefaultLocale,
  retrievalEnabled: agent.retrievalEnabled,
  suggestedQuestionsEnabled: agent.suggestedQuestionsEnabled,
  citationDisplayEnabled: agent.citationDisplayEnabled,
  sourceScope: structuredClone(agent.sourceScope),
  skillSettings: structuredClone(agent.skillSettings),
  chatModelOverride: agent.chatModelOverride ? structuredClone(agent.chatModelOverride) : null,
});
