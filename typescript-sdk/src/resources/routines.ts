import type { InternalClientConfig } from "../core/config.js";
import { requestJson } from "../core/http.js";
import type { components } from "../generated/types.js";

export type RoutineDefinitionListResponse = components["schemas"]["RoutineDefinitionListResponse"];
export type RoutineDefinitionGetResponse = components["schemas"]["RoutineDefinitionGetResponse"];
export type RoutineDefinitionCreateRequest = components["schemas"]["RoutineDefinitionCreateRequest"];
export type RoutineDefinitionUpdateRequest = components["schemas"]["RoutineDefinitionUpdateRequest"];
export type RoutineDefinitionSaveResponse = components["schemas"]["RoutineDefinitionSaveResponse"];
export type RoutineDefinitionLifecycleResponse = components["schemas"]["RoutineDefinitionLifecycleResponse"];
export type RoutineDefinitionPublishResponse = components["schemas"]["RoutineDefinitionPublishResponse"];
export type RoutineDefinitionValidateResponse = components["schemas"]["RoutineDefinitionValidateResponse"];
export type PortableRoutineDocumentEnvelope = components["schemas"]["PortableRoutineDocumentEnvelope"];
export type PortableRoutineDocumentCreateResponse = components["schemas"]["PortableRoutineDocumentCreateResponse"];
export type RoutineDraftAssistRequest = components["schemas"]["RoutineDraftAssistRequest"];
export type RoutineDraftAssistResponse = components["schemas"]["RoutineDraftAssistResponse"];
export type RoutineSkillCatalogResponse = components["schemas"]["RoutineSkillCatalogResponse"];

const routinesBase = (agentId: string): string =>
  `/api/v1/agents/${encodeURIComponent(agentId)}/routines`;

/** Agent-scoped routine authoring: relational definitions, lifecycle, and the portable-markdown round-trip. */
export const createRoutinesResource = (config: InternalClientConfig) => ({
  list: (agentId: string): Promise<RoutineDefinitionListResponse> =>
    requestJson(config, { method: "GET", path: routinesBase(agentId) }),

  create: (agentId: string, body: RoutineDefinitionCreateRequest): Promise<RoutineDefinitionSaveResponse> =>
    requestJson(config, { method: "POST", path: routinesBase(agentId), body }),

  get: (agentId: string, routineId: string): Promise<RoutineDefinitionGetResponse> =>
    requestJson(config, { method: "GET", path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}` }),

  update: (
    agentId: string,
    routineId: string,
    body: RoutineDefinitionUpdateRequest,
  ): Promise<RoutineDefinitionSaveResponse> =>
    requestJson(config, {
      method: "PATCH",
      path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}`,
      body,
    }),

  delete: (agentId: string, routineId: string): Promise<void> =>
    requestJson(config, { method: "DELETE", path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}` }),

  archive: (agentId: string, routineId: string): Promise<RoutineDefinitionLifecycleResponse> =>
    requestJson(config, {
      method: "POST",
      path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}/archive`,
    }),

  restore: (agentId: string, routineId: string): Promise<RoutineDefinitionLifecycleResponse> =>
    requestJson(config, {
      method: "POST",
      path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}/restore`,
    }),

  publish: (agentId: string, routineId: string): Promise<RoutineDefinitionPublishResponse> =>
    requestJson(config, {
      method: "POST",
      path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}/publish`,
    }),

  revise: (agentId: string, routineId: string): Promise<RoutineDefinitionLifecycleResponse> =>
    requestJson(config, {
      method: "POST",
      path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}/revise`,
    }),

  validate: (agentId: string, routineId: string): Promise<RoutineDefinitionValidateResponse> =>
    requestJson(config, {
      method: "POST",
      path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}/validate`,
    }),

  getPortable: (agentId: string, routineId: string): Promise<PortableRoutineDocumentEnvelope> =>
    requestJson(config, {
      method: "GET",
      path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}/portable`,
    }),

  updatePortable: (
    agentId: string,
    routineId: string,
    body: PortableRoutineDocumentEnvelope,
  ): Promise<PortableRoutineDocumentEnvelope> =>
    requestJson(config, {
      method: "PUT",
      path: `${routinesBase(agentId)}/${encodeURIComponent(routineId)}/portable`,
      body,
    }),

  createPortable: (
    agentId: string,
    body: PortableRoutineDocumentEnvelope,
  ): Promise<PortableRoutineDocumentCreateResponse> =>
    requestJson(config, { method: "POST", path: `${routinesBase(agentId)}/portable`, body }),

  draftAssist: (agentId: string, body: RoutineDraftAssistRequest): Promise<RoutineDraftAssistResponse> =>
    requestJson(config, { method: "POST", path: `${routinesBase(agentId)}/draft-assist`, body }),

  skillCatalog: (agentId: string): Promise<RoutineSkillCatalogResponse> =>
    requestJson(config, {
      method: "GET",
      path: `/api/v1/agents/${encodeURIComponent(agentId)}/routine-skill-catalog`,
    }),

  /** Canonicalize a portable routine document without persisting it (workspace-scoped, not agent-bound). */
  canonicalizePortable: (body: PortableRoutineDocumentEnvelope): Promise<PortableRoutineDocumentEnvelope> =>
    requestJson(config, { method: "POST", path: "/api/v1/routines/portable/canonicalize", body }),
});

export type RoutinesResource = ReturnType<typeof createRoutinesResource>;
