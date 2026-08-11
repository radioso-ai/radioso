import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";

import { registerOpenApiPaths } from "./openApiPaths.js";
import { createOpenApiRegistry } from "./openApiRegistry.js";

export const createOpenApiDocument = (
  options: {
    sessionCookieName?: string;
  } = {},
) => {
  const { registry, schemas, security } = createOpenApiRegistry();
  registerOpenApiPaths(registry, schemas, security);

  const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Radioso API",
      version: "0.1.0",
      description: "Grounded retrieval and assistant chat over your documents. Get a workspace API token from your Radioso dashboard, then send it as a Bearer token.",
    },
    servers: [
      {
        url: "https://api.radioso.ai",
        description: "Production",
      },
      {
        url: "https://api-us.radioso.ai",
        description: "Production (US)",
      },
      {
        url: "http://localhost:8080",
        description: "Local development",
      },
    ],
    tags: [
      { name: "System" },
      { name: "Auth" },
      { name: "Account" },
      { name: "Workspace" },
      { name: "Assistant" },
      { name: "History" },
      { name: "Context Variables" },
      { name: "Retrieval" },
      { name: "Settings" },
      { name: "Documents" },
      { name: "Connectors" },
      { name: "Audience Pulse" },
    ],
  });

  const sessionCookie = document.components?.securitySchemes?.sessionCookie;
  if (sessionCookie && "name" in sessionCookie) {
    sessionCookie.name = options.sessionCookieName ?? "radioso_session";
  }

  if (document.components?.securitySchemes) {
    delete document.components.securitySchemes.anonymousSessionCookie;
  }

  const portableSaveRejected = document.components?.schemas?.PortableRoutineSaveRejectedResponse;
  if (
    portableSaveRejected
    && typeof portableSaveRejected === "object"
    && "anyOf" in portableSaveRejected
    && !("oneOf" in portableSaveRejected)
  ) {
    portableSaveRejected.oneOf = portableSaveRejected.anyOf;
    delete portableSaveRejected.anyOf;
  }

  const publicChatPaths = [
    "/api/v1/public/chat/{token}",
    "/api/v1/public/chat/{token}/history/{conversationId}",
    "/api/v1/public/chat/{token}/tail/{conversationId}",
    "/api/v1/public/chat/{token}/events/{conversationId}",
  ] as const;

  const paths = document.paths ?? {};

  for (const path of publicChatPaths) {
    const operations = paths[path];
    if (!operations) {
      continue;
    }

    for (const method of Object.keys(operations) as Array<keyof typeof operations>) {
      const operation = operations[method];
      if (!operation || typeof operation !== "object") {
        continue;
      }

      delete operation.security;
      operation.description = [
        operation.description,
        "Anonymous session continuity is maintained by an HttpOnly cookie set by the server.",
        "The cookie name is workspace-specific (`anon_session_<workspaceId>`) and should be preserved by a browser or cookie jar rather than configured as a fixed client credential.",
      ].filter(Boolean).join("\n\n");
    }
  }

  return document;
};
