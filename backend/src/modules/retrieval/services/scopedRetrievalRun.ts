import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type {
  AgentRetrievalInputs,
  AgentRetrievalScopePort,
} from "../domain/agentRetrievalScope.js";
import type { RetrievalAgentScopeAttribution } from "../domain/retrievalCapabilityTypes.js";

export interface ScopedRetrievalRun {
  readonly inputs: Partial<AgentRetrievalInputs>;
  readonly attribution: RetrievalAgentScopeAttribution | null;
}

const UNSCOPED: ScopedRetrievalRun = { inputs: {}, attribution: null };

/**
 * Resolves the agent configuration a retrieval run is attributed to. A named
 * agent that cannot be scoped fails the run: silently answering with workspace
 * defaults would report retrieval behavior the agent does not have.
 */
export const resolveScopedRetrievalRun = async (
  agentRetrievalScope: AgentRetrievalScopePort | undefined,
  input: { workspaceId: string; agentId?: string | null },
): Promise<ScopedRetrievalRun> => {
  if (!input.agentId) {
    return UNSCOPED;
  }
  if (!agentRetrievalScope) {
    throw badRequest("Agent-scoped retrieval is unavailable on this surface.", {
      code: "agent_scoped_retrieval_unavailable",
    });
  }
  const scope = await agentRetrievalScope.resolveForAgent({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
  });
  if (!scope) {
    throw notFound("Agent not found");
  }
  const { retrievalEnabled, ...inputs } = scope;
  return {
    inputs,
    attribution: { agentId: input.agentId, retrievalEnabled },
  };
};
