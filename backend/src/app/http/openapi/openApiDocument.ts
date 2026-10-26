import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";

import { registerOpenApiPaths } from "./openApiPaths.js";
import { createOpenApiRegistry } from "./openApiRegistry.js";

// An unescaped slash and regex flags closing a pattern: what is left of `/source/flags` once only
// its leading slash is trimmed. A slash inside a regex literal's source is always escaped.
const TRAILING_REGEX_FLAGS = /(?<!\\)\/[dgimsuvy]+$/;

const isEmptySchema = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;

/**
 * Two corrections to what zod-to-openapi emits, so the document states the contract as it always
 * has:
 * - It writes a `.regex()` check's `pattern` from the regex's `toString()` with only the slashes
 *   trimmed, so a flagged literal such as `/^[a-z]+$/u` arrives as `^[a-z]+$/u` — a pattern no
 *   value matches. JSON Schema patterns carry no flags; this keeps the regex source.
 * - It spells a passthrough object's open key set as `additionalProperties: {}`, which says
 *   nothing an object schema without the keyword does not already say. Dropping it keeps generated
 *   clients from typing those objects with an index signature they never had. A record keeps the
 *   keyword: there it is the whole description of the values.
 */
const normalizeGeneratedSchemas = (node: unknown): void => {
  if (Array.isArray(node)) {
    node.forEach(normalizeGeneratedSchemas);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if ("properties" in record && isEmptySchema(record.additionalProperties)) delete record.additionalProperties;
  for (const [key, value] of Object.entries(record)) {
    if (key === "pattern" && typeof value === "string") record[key] = value.replace(TRAILING_REGEX_FLAGS, "");
    else normalizeGeneratedSchemas(value);
  }
};

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
      description: "Grounded retrieval and assistant chat over your documents. Create a personal token or service-account credential in API access settings, then send it as a Bearer token.",
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
      { name: "Realtime" },
      { name: "Assistant" },
      { name: "Agent Channels" },
      { name: "History" },
      { name: "Privacy" },
      { name: "Context Variables" },
      { name: "Retrieval" },
      { name: "Settings" },
      { name: "Documents" },
      { name: "Connectors" },
      { name: "Audience Pulse" },
      { name: "Copilot" },
      { name: "MCP Converse" },
      { name: "Operator MCP" },
    ],
  });

  normalizeGeneratedSchemas(document);

  const sessionCookie = document.components?.securitySchemes?.sessionCookie;
  if (sessionCookie && "name" in sessionCookie) {
    sessionCookie.name = options.sessionCookieName ?? "radioso_session";
  }

  if (document.components?.securitySchemes) {
    delete document.components.securitySchemes.anonymousSessionCookie;
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
