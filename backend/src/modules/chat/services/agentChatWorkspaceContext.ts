import type { AgentRecord } from "../../agents/public.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";

/**
 * The LLM resolve input for a model call made on an agent's own turn. The
 * agent's chat model override wins over the workspace "chat" preference, so
 * the planner, the answer, and the coverage assessment all run on the model
 * the operator chose for this agent — a lower-latency override that only
 * reached the answer left the planner, the longest stage, on the default tier.
 */
export const buildAgentChatWorkspaceContext = (
  agent: Pick<AgentRecord, "workspaceId" | "chatModelOverride">,
): LlmCapabilityResolveInput => ({
  workspaceId: agent.workspaceId,
  capabilityOverride: agent.chatModelOverride ?? undefined,
});
