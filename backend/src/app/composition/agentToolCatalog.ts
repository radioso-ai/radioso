import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import type { AgentRevisionRuntimeReaderPort } from "../../modules/agents/public.js";
import { createAgentToolCatalog, type AgentToolCatalogPort } from "../../modules/routines/public.js";

/**
 * The agent tool catalog a calling agent reads (`GET /mcp/converse/tools`) and
 * both agent-facing doors validate a tool call against. The routines module
 * owns what a descriptor is and which routines qualify; this wires its two
 * narrow readers over the live agent row and the immutable release store —
 * the conversation's pinned revision when one is named, otherwise the agent's
 * current published one. Drafts never reach this path.
 */
export const createAgentToolCatalogComposition = (input: {
  agentRepository: Pick<AgentRepositoryPort, "findByIdAndWorkspaceId">;
  agentRevisionReader: AgentRevisionRuntimeReaderPort;
}): AgentToolCatalogPort =>
  createAgentToolCatalog({
    agents: {
      find: async ({ workspaceId, agentId }) => {
        const agent = await input.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
        return agent ? { name: agent.name, description: null } : null;
      },
    },
    publishedRoutines: {
      listPublished: async ({ workspaceId, agentId, agentRevisionId }) => {
        const revision = agentRevisionId
          ? await input.agentRevisionReader.findRevision({ workspaceId, agentId, revisionId: agentRevisionId })
          : await input.agentRevisionReader.findCurrentPublished({ workspaceId, agentId });
        return revision?.snapshot.routines ?? [];
      },
    },
  });
