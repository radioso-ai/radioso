import type { InternalClientConfig } from "../core/config.js";
import { requestJson } from "../core/http.js";
import type { components } from "../generated/types.js";

export type DirectiveListResponse = components["schemas"]["DirectiveListResponse"];
export type DirectiveDraftRequest = components["schemas"]["DirectiveDraftRequest"];
export type DirectiveDraftResponse = components["schemas"]["DirectiveDraftResponse"];
export type AuthoredDirectiveCreateRequest = components["schemas"]["AuthoredDirectiveCreateRequest"];
export type AuthoredDirectiveUpdateRequest = components["schemas"]["AuthoredDirectiveUpdateRequest"];
export type AuthoredDirectiveSaveResponse = components["schemas"]["AuthoredDirectiveSaveResponse"];

const directivesBase = (agentId: string): string =>
  `/api/v1/agents/${encodeURIComponent(agentId)}/directives`;

/** Agent-scoped directive (guideline) authoring. */
export const createDirectivesResource = (config: InternalClientConfig) => ({
  list: (agentId: string): Promise<DirectiveListResponse> =>
    requestJson(config, { method: "GET", path: directivesBase(agentId) }),

  draft: (agentId: string, body: DirectiveDraftRequest): Promise<DirectiveDraftResponse> =>
    requestJson(config, { method: "POST", path: `${directivesBase(agentId)}/draft`, body }),

  create: (agentId: string, body: AuthoredDirectiveCreateRequest): Promise<AuthoredDirectiveSaveResponse> =>
    requestJson(config, { method: "POST", path: directivesBase(agentId), body }),

  update: (
    agentId: string,
    directiveId: string,
    body: AuthoredDirectiveUpdateRequest,
  ): Promise<AuthoredDirectiveSaveResponse> =>
    requestJson(config, {
      method: "PATCH",
      path: `${directivesBase(agentId)}/${encodeURIComponent(directiveId)}`,
      body,
    }),

  delete: (agentId: string, directiveId: string): Promise<void> =>
    requestJson(config, {
      method: "DELETE",
      path: `${directivesBase(agentId)}/${encodeURIComponent(directiveId)}`,
    }),
});

export type DirectivesResource = ReturnType<typeof createDirectivesResource>;
