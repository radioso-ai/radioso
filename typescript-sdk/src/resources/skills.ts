import type { InternalClientConfig } from "../core/config.js";
import { requestJson } from "../core/http.js";
import type { OkResponseOf, RequestBodyOf } from "./operationTypes.js";

// These skill-config endpoints declare their bodies inline in the OpenAPI document,
// so their types are extracted from the `operations` map by operationId.
export type AgentSkillListResponse = OkResponseOf<"listAgentSkills">;
export type AgentSkillCreateRequest = RequestBodyOf<"createAgentSkill">;
export type AgentSkillSaveResponse = OkResponseOf<"createAgentSkill">;
export type AgentSkillUpdateRequest = RequestBodyOf<"updateAgentSkill">;
export type AgentSkillCapabilitiesResponse = OkResponseOf<"listAgentSkillCapabilities">;

export type AgentEmailSkillListResponse = OkResponseOf<"listAgentEmailSkills">;
export type AgentEmailSkillCreateRequest = RequestBodyOf<"createAgentEmailSkill">;
export type AgentEmailSkillResponse = OkResponseOf<"getAgentEmailSkill">;
export type AgentEmailSkillUpdateRequest = RequestBodyOf<"updateAgentEmailSkill">;

export type ExternalSkillListResponse = OkResponseOf<"listExternalSkills">;
export type ExternalSkillCreateRequest = RequestBodyOf<"createExternalSkill">;
export type ExternalSkillResponse = OkResponseOf<"getExternalSkill">;
export type ExternalSkillUpdateRequest = RequestBodyOf<"updateExternalSkill">;

export type WebhookSkillListResponse = OkResponseOf<"listAgentWebhookSkills">;
export type WebhookSkillCreateRequest = RequestBodyOf<"createAgentWebhookSkill">;
export type WebhookSkillResponse = OkResponseOf<"getAgentWebhookSkill">;
export type WebhookSkillUpdateRequest = RequestBodyOf<"updateAgentWebhookSkill">;

export type SlackSkillListResponse = OkResponseOf<"listAgentSlackSkills">;
export type SlackSkillCreateRequest = RequestBodyOf<"createAgentSlackSkill">;
export type SlackSkillResponse = OkResponseOf<"getAgentSlackSkill">;
export type SlackSkillUpdateRequest = RequestBodyOf<"updateAgentSlackSkill">;

const agentPath = (agentId: string, suffix: string): string =>
  `/api/v1/agents/${encodeURIComponent(agentId)}/${suffix}`;

/** Generic agent skill bindings (retrieve, notify, and other capability-backed skills). */
export const createSkillsResource = (config: InternalClientConfig) => ({
  list: (agentId: string): Promise<AgentSkillListResponse> =>
    requestJson(config, { method: "GET", path: agentPath(agentId, "skills") }),

  create: (agentId: string, body: AgentSkillCreateRequest): Promise<AgentSkillSaveResponse> =>
    requestJson(config, { method: "POST", path: agentPath(agentId, "skills"), body }),

  update: (agentId: string, skillId: string, body: AgentSkillUpdateRequest): Promise<AgentSkillSaveResponse> =>
    requestJson(config, {
      method: "PATCH",
      path: agentPath(agentId, `skills/${encodeURIComponent(skillId)}`),
      body,
    }),

  delete: (agentId: string, skillId: string): Promise<void> =>
    requestJson(config, {
      method: "DELETE",
      path: agentPath(agentId, `skills/${encodeURIComponent(skillId)}`),
    }),

  capabilities: (agentId: string): Promise<AgentSkillCapabilitiesResponse> =>
    requestJson(config, { method: "GET", path: agentPath(agentId, "skill-capabilities") }),
});

export type SkillsResource = ReturnType<typeof createSkillsResource>;

/** Email skill bindings (draft/send customer email via a connected mailbox). */
export const createEmailSkillsResource = (config: InternalClientConfig) => ({
  list: (agentId: string): Promise<AgentEmailSkillListResponse> =>
    requestJson(config, { method: "GET", path: agentPath(agentId, "email-skills") }),

  create: (agentId: string, body: AgentEmailSkillCreateRequest): Promise<AgentEmailSkillResponse> =>
    requestJson(config, { method: "POST", path: agentPath(agentId, "email-skills"), body }),

  get: (agentId: string, skillId: string): Promise<AgentEmailSkillResponse> =>
    requestJson(config, {
      method: "GET",
      path: agentPath(agentId, `email-skills/${encodeURIComponent(skillId)}`),
    }),

  update: (agentId: string, skillId: string, body: AgentEmailSkillUpdateRequest): Promise<AgentEmailSkillResponse> =>
    requestJson(config, {
      method: "PATCH",
      path: agentPath(agentId, `email-skills/${encodeURIComponent(skillId)}`),
      body,
    }),

  delete: (agentId: string, skillId: string): Promise<void> =>
    requestJson(config, {
      method: "DELETE",
      path: agentPath(agentId, `email-skills/${encodeURIComponent(skillId)}`),
    }),
});

export type EmailSkillsResource = ReturnType<typeof createEmailSkillsResource>;

/** External (MCP tool-backed) skill bindings. */
export const createExternalSkillsResource = (config: InternalClientConfig) => ({
  list: (agentId: string): Promise<ExternalSkillListResponse> =>
    requestJson(config, { method: "GET", path: agentPath(agentId, "external-skills") }),

  create: (agentId: string, body: ExternalSkillCreateRequest): Promise<ExternalSkillResponse> =>
    requestJson(config, { method: "POST", path: agentPath(agentId, "external-skills"), body }),

  get: (agentId: string, skillId: string): Promise<ExternalSkillResponse> =>
    requestJson(config, {
      method: "GET",
      path: agentPath(agentId, `external-skills/${encodeURIComponent(skillId)}`),
    }),

  update: (agentId: string, skillId: string, body: ExternalSkillUpdateRequest): Promise<ExternalSkillResponse> =>
    requestJson(config, {
      method: "PATCH",
      path: agentPath(agentId, `external-skills/${encodeURIComponent(skillId)}`),
      body,
    }),

  delete: (agentId: string, skillId: string): Promise<void> =>
    requestJson(config, {
      method: "DELETE",
      path: agentPath(agentId, `external-skills/${encodeURIComponent(skillId)}`),
    }),
});

export type ExternalSkillsResource = ReturnType<typeof createExternalSkillsResource>;

/** Webhook skill bindings (call a signed workspace webhook destination). */
export const createWebhookSkillsResource = (config: InternalClientConfig) => ({
  list: (agentId: string): Promise<WebhookSkillListResponse> =>
    requestJson(config, { method: "GET", path: agentPath(agentId, "webhook-skills") }),

  create: (agentId: string, body: WebhookSkillCreateRequest): Promise<WebhookSkillResponse> =>
    requestJson(config, { method: "POST", path: agentPath(agentId, "webhook-skills"), body }),

  get: (agentId: string, skillId: string): Promise<WebhookSkillResponse> =>
    requestJson(config, {
      method: "GET",
      path: agentPath(agentId, `webhook-skills/${encodeURIComponent(skillId)}`),
    }),

  update: (agentId: string, skillId: string, body: WebhookSkillUpdateRequest): Promise<WebhookSkillResponse> =>
    requestJson(config, {
      method: "PATCH",
      path: agentPath(agentId, `webhook-skills/${encodeURIComponent(skillId)}`),
      body,
    }),

  delete: (agentId: string, skillId: string): Promise<void> =>
    requestJson(config, {
      method: "DELETE",
      path: agentPath(agentId, `webhook-skills/${encodeURIComponent(skillId)}`),
    }),
});

export type WebhookSkillsResource = ReturnType<typeof createWebhookSkillsResource>;

/** Slack skill bindings (post to a Slack channel via the connected workspace app). */
export const createSlackSkillsResource = (config: InternalClientConfig) => ({
  list: (agentId: string): Promise<SlackSkillListResponse> =>
    requestJson(config, { method: "GET", path: agentPath(agentId, "slack-skills") }),

  create: (agentId: string, body: SlackSkillCreateRequest): Promise<SlackSkillResponse> =>
    requestJson(config, { method: "POST", path: agentPath(agentId, "slack-skills"), body }),

  get: (agentId: string, skillId: string): Promise<SlackSkillResponse> =>
    requestJson(config, {
      method: "GET",
      path: agentPath(agentId, `slack-skills/${encodeURIComponent(skillId)}`),
    }),

  update: (agentId: string, skillId: string, body: SlackSkillUpdateRequest): Promise<SlackSkillResponse> =>
    requestJson(config, {
      method: "PATCH",
      path: agentPath(agentId, `slack-skills/${encodeURIComponent(skillId)}`),
      body,
    }),

  delete: (agentId: string, skillId: string): Promise<void> =>
    requestJson(config, {
      method: "DELETE",
      path: agentPath(agentId, `slack-skills/${encodeURIComponent(skillId)}`),
    }),
});

export type SlackSkillsResource = ReturnType<typeof createSlackSkillsResource>;
