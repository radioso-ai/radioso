import type { InternalClientConfig } from "../core/config.js";
import { requestJson } from "../core/http.js";
import type { components } from "../generated/types.js";

export type AgentBundle = components["schemas"]["AgentBundle"];
export type AgentBundleImportRequest = components["schemas"]["AgentBundleImportRequest"];
export type AgentBundleImportResponse = components["schemas"]["AgentBundleImportResponse"];

/**
 * Portable agent export/import: an agent's config, routines, context-variable
 * enablements and skills composed into one transferable bundle.
 *
 * Import is not agent-scoped by an existing id — it creates a new agent from
 * the bundle — so, unlike routines/directives/contextVariables, neither method
 * here takes an agentId as its first argument the same way.
 */
export const createAgentBundleResource = (config: InternalClientConfig) => ({
  export: (agentId: string): Promise<AgentBundle> =>
    requestJson(config, {
      method: "GET",
      path: `/api/v1/agents/${encodeURIComponent(agentId)}/bundle`,
    }),

  import: (body: AgentBundleImportRequest): Promise<AgentBundleImportResponse> =>
    requestJson(config, { method: "POST", path: "/api/v1/agents/bundle", body }),
});

export type AgentBundleResource = ReturnType<typeof createAgentBundleResource>;
