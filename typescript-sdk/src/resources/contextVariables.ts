import type { InternalClientConfig } from "../core/config.js";
import { requestJson } from "../core/http.js";
import type { components } from "../generated/types.js";
import type { QueryParamsOf } from "./operationTypes.js";

export type AgentContextVariableEnablementListResponse =
  components["schemas"]["AgentContextVariableEnablementListResponse"];
export type AgentContextVariableEnablementRequest =
  components["schemas"]["AgentContextVariableEnablementRequest"];
export type AgentContextVariableEnablementResponse =
  components["schemas"]["AgentContextVariableEnablementResponse"];
export type ContextVariableSigningKeyResponse = components["schemas"]["ContextVariableSigningKeyResponse"];
export type ContextVariableListResponse = components["schemas"]["ContextVariableListResponse"];
export type ContextVariableCreateRequest = components["schemas"]["ContextVariableCreateRequest"];
export type ContextVariableUpdateRequest = components["schemas"]["ContextVariableUpdateRequest"];
export type ContextVariableResponse = components["schemas"]["ContextVariableResponse"];
export type ContextVariableValueUpsertRequest = components["schemas"]["ContextVariableValueUpsertRequest"];
export type ContextVariableValueDeleteRequest = components["schemas"]["ContextVariableValueDeleteRequest"];
export type ContextVariableValueResponse = components["schemas"]["ContextVariableValueResponse"];
export type ContextVariableValueScopeQuery = QueryParamsOf<"getContextVariableValue">;

const workspaceBase = "/api/v1/context-variables";
const agentBase = (agentId: string): string =>
  `/api/v1/agents/${encodeURIComponent(agentId)}/context-variables`;

/** Workspace-scoped context-variable definitions and their scoped values. */
export const createContextVariablesResource = (config: InternalClientConfig) => ({
  list: (): Promise<ContextVariableListResponse> =>
    requestJson(config, { method: "GET", path: workspaceBase }),

  create: (body: ContextVariableCreateRequest): Promise<ContextVariableResponse> =>
    requestJson(config, { method: "POST", path: workspaceBase, body }),

  get: (id: string): Promise<ContextVariableResponse> =>
    requestJson(config, { method: "GET", path: `${workspaceBase}/${encodeURIComponent(id)}` }),

  update: (id: string, body: ContextVariableUpdateRequest): Promise<ContextVariableResponse> =>
    requestJson(config, { method: "PATCH", path: `${workspaceBase}/${encodeURIComponent(id)}`, body }),

  delete: (id: string): Promise<void> =>
    requestJson(config, { method: "DELETE", path: `${workspaceBase}/${encodeURIComponent(id)}` }),

  getValue: (id: string, query: ContextVariableValueScopeQuery): Promise<ContextVariableValueResponse> =>
    requestJson(config, {
      method: "GET",
      path: `${workspaceBase}/${encodeURIComponent(id)}/values`,
      query: { ...query },
    }),

  upsertValue: (id: string, body: ContextVariableValueUpsertRequest): Promise<ContextVariableValueResponse> =>
    requestJson(config, { method: "PUT", path: `${workspaceBase}/${encodeURIComponent(id)}/values`, body }),

  deleteValue: (id: string, body: ContextVariableValueDeleteRequest): Promise<void> =>
    requestJson(config, { method: "DELETE", path: `${workspaceBase}/${encodeURIComponent(id)}/values`, body }),
});

export type ContextVariablesResource = ReturnType<typeof createContextVariablesResource>;

/** Agent-scoped enablement/binding of workspace context variables. */
export const createAgentContextVariablesResource = (config: InternalClientConfig) => ({
  list: (agentId: string): Promise<AgentContextVariableEnablementListResponse> =>
    requestJson(config, { method: "GET", path: agentBase(agentId) }),

  getSigningKey: (agentId: string): Promise<ContextVariableSigningKeyResponse> =>
    requestJson(config, { method: "GET", path: `${agentBase(agentId)}/signing-key` }),

  upsert: (
    agentId: string,
    variableId: string,
    body: AgentContextVariableEnablementRequest,
  ): Promise<AgentContextVariableEnablementResponse> =>
    requestJson(config, {
      method: "PUT",
      path: `${agentBase(agentId)}/${encodeURIComponent(variableId)}`,
      body,
    }),

  delete: (agentId: string, variableId: string): Promise<void> =>
    requestJson(config, {
      method: "DELETE",
      path: `${agentBase(agentId)}/${encodeURIComponent(variableId)}`,
    }),
});

export type AgentContextVariablesResource = ReturnType<typeof createAgentContextVariablesResource>;
