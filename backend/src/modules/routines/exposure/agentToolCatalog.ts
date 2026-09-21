import { notFound } from "../../../shared/domain/errors.js";
import type { RoutineDefinition } from "../domain.js";
import { routineCanActivate } from "../compiler.js";
import { buildAgentToolDescriptor, type AgentToolDescriptor } from "./agentToolDescriptor.js";

export interface AgentToolCatalogScope {
  workspaceId: string;
  agentId: string;
  /** The release a conversation is pinned to; absent reads the agent's current published release. */
  agentRevisionId?: string;
}

/** What a calling agent is told about the agent beside its tools. */
interface AgentToolCatalogAgent {
  name: string;
  description: string | null;
}

export interface AgentToolCatalog {
  agent: AgentToolCatalogAgent;
  tools: AgentToolDescriptor[];
}

/** Narrow read of the agent an agent-facing caller is bound to; composition implements it. */
interface AgentToolCatalogAgentReader {
  find(input: { workspaceId: string; agentId: string }): Promise<AgentToolCatalogAgent | null>;
}

/**
 * The routines a release carries, parked ones included. Composition implements
 * this over the agent revision store (the pinned revision when one is named,
 * otherwise the current published one); a draft is never on this path.
 */
interface PublishedRoutineReader {
  listPublished(input: AgentToolCatalogScope): Promise<RoutineDefinition[]>;
}

export interface AgentToolCatalogPort {
  load(input: AgentToolCatalogScope): Promise<AgentToolCatalog>;
}

/** A routine serves as a tool when it can activate at all and its exposure is switched on. */
const isExposedForAgents = <T extends Pick<RoutineDefinition, "enabled" | "exposure">>(
  definition: T,
): definition is T & { exposure: NonNullable<RoutineDefinition["exposure"]> } =>
  routineCanActivate(definition) && definition.exposure?.enabled === true;

export const createAgentToolCatalog = (dependencies: {
  agents: AgentToolCatalogAgentReader;
  publishedRoutines: PublishedRoutineReader;
}): AgentToolCatalogPort => ({
  async load(input) {
    const agent = await dependencies.agents.find({ workspaceId: input.workspaceId, agentId: input.agentId });
    if (!agent) {
      throw notFound("Agent not found");
    }
    const routines = await dependencies.publishedRoutines.listPublished(input);
    return {
      agent,
      tools: routines
        .filter(isExposedForAgents)
        .map((definition) => buildAgentToolDescriptor(definition)),
    };
  },
});
