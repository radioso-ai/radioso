import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const SlackAgentParams = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
});

const SlackInstallStartResponseSchema = z.object({
  authorizationUrl: z.string().url(),
  connectionId: z.string().uuid(),
  status: z.literal("pending"),
});

const SlackInstallStatusSchema = z.object({
  status: z.enum(["connected", "needs_reauth", "disabled", "not_configured"]),
  installationId: z.string().uuid().optional(),
  teamName: z.string().optional(),
  answeringAgentId: z.string().uuid().optional(),
});

const SlackBindingSchema = z.object({
  answeringAgentId: z.string().uuid().nullable(),
  escalationChannelId: z.string().nullable(),
});

const SlackBindingUpdateSchema = z.object({
  answeringAgentId: z.string().uuid(),
  escalationChannelId: z.string().nullable().optional(),
});

const SlackManifestResponseSchema = z.object({
  manifest: z.object({
    display_information: z.object({
      name: z.string(),
    }),
    features: z.object({
      bot_user: z.object({
        display_name: z.string(),
        always_online: z.boolean(),
      }),
    }),
    oauth_config: z.object({
      redirect_urls: z.array(z.string().url()),
      scopes: z.object({
        bot: z.array(z.string()),
      }),
    }),
    settings: z.object({
      event_subscriptions: z.object({
        request_url: z.string().url(),
        bot_events: z.array(z.string()),
      }),
      interactivity: z.object({
        is_enabled: z.boolean(),
      }),
      org_deploy_enabled: z.boolean(),
      socket_mode_enabled: z.boolean(),
      token_rotation_enabled: z.boolean(),
    }),
  }),
  requiredEnvVars: z.array(z.enum(["SLACK_OAUTH_CLIENT_ID", "SLACK_OAUTH_CLIENT_SECRET", "SLACK_SIGNING_SECRET"])),
});

const TAGS = ["Slack"];

export const registerSlackPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });

  registry.registerPath({
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/install/start",
    tags: TAGS,
    summary: "Start Slack OAuth installation",
    operationId: "startAgentSlackInstall",
    security: sec,
    request: { params: SlackAgentParams },
    responses: {
      200: { description: "Slack authorization started", content: json(SlackInstallStartResponseSchema) },
      400: errorResponse("Invalid request or Slack OAuth is not configured"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/install/status",
    tags: TAGS,
    summary: "Get Slack installation status",
    operationId: "getAgentSlackInstallStatus",
    security: sec,
    request: { params: SlackAgentParams },
    responses: {
      200: { description: "Slack installation status", content: json(SlackInstallStatusSchema) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/manifest",
    tags: TAGS,
    summary: "Get self-host Slack app manifest",
    operationId: "getAgentSlackManifest",
    security: sec,
    request: { params: SlackAgentParams },
    responses: {
      200: { description: "Generated Slack app manifest", content: json(SlackManifestResponseSchema) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/binding",
    tags: TAGS,
    summary: "Get Slack answering binding",
    operationId: "getAgentSlackBinding",
    security: sec,
    request: { params: SlackAgentParams },
    responses: {
      200: { description: "Slack binding", content: json(SlackBindingSchema) },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent read permission required"),
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/binding",
    tags: TAGS,
    summary: "Set Slack answering binding",
    operationId: "setAgentSlackBinding",
    security: sec,
    request: {
      params: SlackAgentParams,
      body: { required: true, content: json(SlackBindingUpdateSchema) },
    },
    responses: {
      200: { description: "Slack binding", content: json(SlackBindingSchema) },
      400: errorResponse("Invalid binding request"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
      404: errorResponse("Slack installation not configured"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/installation",
    tags: TAGS,
    summary: "Disconnect Slack installation",
    operationId: "disconnectAgentSlackInstallation",
    security: sec,
    request: { params: SlackAgentParams },
    responses: {
      204: { description: "Disconnected" },
      401: errorResponse("Authentication required"),
      403: errorResponse("Agent manage permission required"),
    },
  });
};
