import type { AgentRecord } from "../../agents/public.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";

/**
 * The LLM resolve input for a model call made on an agent's own turn. The
 * agent's chat model override wins over the workspace "chat" preference, so
 * the planner, the answer, and the coverage assessment all run on the model
 * the operator chose for this agent — a lower-latency override that only
 * reached the answer left the planner, the longest stage, on the default tier.
 *
 * The rule: the override governs the calls that produce the turn the visitor
 * asked for. Calls that exist to recover from or refuse that turn — the staged
 * router and interpreter (rewrite tier), the staged directive matcher and the
 * no-context decline (workspace chat tier) — keep their own tiers, because they
 * run precisely when the chosen model has already failed a contract. An override
 * that cannot return a valid plan therefore makes every turn pay the planner
 * attempt and then the staged path; the `turn_planning` model-call trace and
 * usage event carry the model, which is where to look when that happens.
 */
export const buildAgentChatWorkspaceContext = (
  agent: Pick<AgentRecord, "workspaceId" | "chatModelOverride">,
): LlmCapabilityResolveInput => ({
  workspaceId: agent.workspaceId,
  capabilityOverride: agent.chatModelOverride ?? undefined,
});
