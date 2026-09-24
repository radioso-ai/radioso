import { readProductDoc } from "@radioso/product-docs";

import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import type { AgentPublicProfile, AgentPublicProfilePort } from "../../modules/agentDiscovery/public.js";
import { agentMcpEndpointUrl } from "../../modules/agentDiscovery/public.js";
import type { AgentRevisionRuntimeReaderPort } from "../../modules/agents/public.js";
import type { AgentToolCatalogPort } from "../../modules/routines/public.js";

/**
 * The guide a discovery document sends a calling agent to read. Its published URL comes
 * from the documentation corpus this build ships, the same place every other product-docs
 * link is resolved from, so the link follows the docs rather than a deployment setting. A
 * corpus without the page leaves the link off the card rather than guessing one.
 */
const CONNECT_GUIDE_SLUG = "guides/agent-converse";
const connectGuideUrl = (): string | null => readProductDoc(CONNECT_GUIDE_SLUG)?.url ?? null;

/**
 * The profile a public document renders from: the live agent row decides whether there is
 * anything to publish, the current published release decides what it says, and the public
 * MCP endpoint is deployment configuration. The discovery module owns the document shapes
 * and learns none of this.
 */
export const createAgentPublicProfileComposition = (input: {
  agentRepository: Pick<AgentRepositoryPort, "findByPublicId">;
  agentRevisionReader: AgentRevisionRuntimeReaderPort;
  agentToolCatalog: AgentToolCatalogPort;
  /** Public base URL of the MCP endpoint, e.g. `https://mcp.example.com/mcp`. */
  mcpBaseUrl?: string;
}): AgentPublicProfilePort => ({
  async load(publicId: string): Promise<AgentPublicProfile | null> {
    if (!input.mcpBaseUrl) {
      // Refusing is the safe failure. A card without `url` is not an A2A card, and a card
      // with a guessed one sends callers somewhere that does not answer — either way the
      // caller's next move fails further from the cause. A 500 names the misconfiguration.
      throw new Error("PUBLIC_MCP_CONVERSE_URL is not configured; agent discovery documents cannot name an endpoint.");
    }
    const agent = await input.agentRepository.findByPublicId(publicId);
    if (!agent || !agent.agentCardEnabled) {
      return null;
    }
    const revision = await input.agentRevisionReader.findCurrentPublished({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
    });
    if (!revision?.publishedAt) {
      return null;
    }
    const catalog = await input.agentToolCatalog.load({
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      agentRevisionId: revision.id,
    });
    return {
      publicId,
      name: agent.name,
      // The catalog already applied the "blank is absent" rule to the same field; reading its
      // answer keeps the card and the composed `ask_agent` description from ever disagreeing.
      description: catalog.agent.description,
      mcpEndpointUrl: agentMcpEndpointUrl(input.mcpBaseUrl, publicId),
      documentationUrl: connectGuideUrl(),
      walkInEnabled: agent.publicAgentAccessEnabled,
      tools: catalog.tools,
      revisionVersion: String(revision.publishedVersion ?? 1),
      revisionPublishedAt: revision.publishedAt.toISOString(),
    };
  },
});
