import type { AgentRecord } from "../../agents/public.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";

/**
 * The LLM resolve input for a model call made on an agent's own turn. The
 * agent's chat model override wins over the workspace "chat" preference, so
 * the planner, the answer, and the coverage assessment all run on the model
 * the operator chose for this agent — a lower-latency override that only
 * reached the answer left the planner, the longest stage, on the default tier.
 *
 * The rule: the override is a *chat-tier* override for the calls that produce
 * the visitor's turn. Two groups deliberately do not receive it:
 *
 * - The staged router, interpreter, and language detector are rewrite-tier
 *   calls, so a chat override is out of scope by definition. The resolver would
 *   honour `capabilityOverride` on any tier, so this is caller discipline: those
 *   callers pass `{ workspaceId }` alone, and a test pins it.
 * - The staged directive matcher and the no-context decline are chat-tier calls
 *   that stay on the workspace preference because they serve more than planner
 *   failure: the staged path also runs on every bypassed turn (active routine,
 *   routine claim, over-bound candidates, pending clarification), and the
 *   decline fires on a retrieval miss.
 *
 * An override that cannot return a valid plan makes every eligible turn pay the
 * planner attempt and then the staged path; the `turn_planning` model-call trace
 * and usage event carry the model, which is where to look when that happens.
 */
export const buildAgentChatWorkspaceContext = (
  agent: Pick<AgentRecord, "workspaceId" | "chatModelOverride">,
): LlmCapabilityResolveInput => ({
  workspaceId: agent.workspaceId,
  capabilityOverride: agent.chatModelOverride ?? undefined,
});
