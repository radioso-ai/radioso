import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const ConnectionParams = z.object({ connectionId: z.string().uuid() });
const AuthSchemeSchema = z.enum(["none", "bearer", "header", "basic"]);
const MethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ValueTypeSchema = z.enum(["text", "number", "boolean", "date", "email"]);
const OutcomeSchema = z.enum(["completed", "not_found", "rejected", "missing_input", "invalid_input", "unverified", "failed"]);
const FailureReasonSchema = z.enum([
  "response_mismatch",
  "outputs_too_large",
  "non_json_response",
  "timeout",
  "network",
  "upstream_error",
  "auth_rejected",
  "rate_limited",
  "redirect_refused",
  "connection_not_found",
  "blocked",
  "response_too_large",
  "credential_unavailable",
  "method_not_read_only",
  "skill_not_found",
  "invalid_config",
  "context_missing",
]);
const DefaultHeadersSchema = z.record(z.string(), z.string());

const ScalarOutputSchema = z.object({
  path: z.string(),
  type: ValueTypeSchema,
  description: z.string().optional(),
  required: z.boolean().default(false),
});

const ListFieldSchema = z.object({
  path: z.string(),
  type: ValueTypeSchema,
  description: z.string().optional(),
  role: z.enum(["key", "title", "subtitle", "image", "link"]).optional(),
});

const ListOutputSchema = z.object({
  path: z.string(),
  type: z.literal("list"),
  description: z.string().optional(),
  required: z.boolean().default(false),
  maxItems: z.number().int().min(1).max(20).default(10),
  fields: z.record(z.string(), ListFieldSchema),
});

export const registerApiConnectionsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const ApiConnectionSchema = registry.register("ApiConnection", z.object({
    id: z.string().uuid(),
    name: z.string(),
    baseUrl: z.string(),
    authScheme: AuthSchemeSchema,
    authHeaderName: z.string().nullable(),
    credentialMask: z.string().nullable().describe("The credential's last four characters behind asterisks; null when the connection has none. The credential itself is never returned."),
    defaultHeaders: DefaultHeadersSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  }));
  const ApiConnectionCreateSchema = registry.register("ApiConnectionCreateRequest", z.object({
    name: z.string(),
    baseUrl: z.string().describe("https base URL every request's path is appended to; no query or fragment."),
    authScheme: AuthSchemeSchema.default("none"),
    authHeaderName: z.string().optional().describe("The header the credential is sent in; required for the header scheme."),
    credential: z.string().optional().describe("Write-only. A bearer token, a header value, or username:password for basic; required unless the scheme is none."),
    defaultHeaders: DefaultHeadersSchema.default({}),
  }));
  const ApiConnectionUpdateSchema = registry.register("ApiConnectionUpdateRequest", z.object({
    name: z.string().optional(),
    baseUrl: z.string().optional(),
    authScheme: AuthSchemeSchema.optional(),
    authHeaderName: z.string().nullable().optional(),
    credential: z.string().optional().describe("Write-only. Omit to keep the stored credential; required when the update changes the base URL's origin, the auth scheme or the auth header name."),
    defaultHeaders: DefaultHeadersSchema.optional(),
  }));
  const ApiRequestOutputSchema = registry.register("ApiRequestOutput", z.union([ScalarOutputSchema, ListOutputSchema]));
  const ApiRequestTestSchema = registry.register("ApiRequestTestRequest", z.object({
    method: MethodSchema,
    path: z.string().describe("Path appended to the base URL; a {param} placeholder takes the param's value."),
    boundParams: z.record(z.string(), z.unknown()).default({}),
    exposedSampleValues: z.record(z.string(), z.unknown()).default({}),
    outputs: z.record(z.string(), ApiRequestOutputSchema).default({}),
  }));
  const ApiRequestTestResultSchema = registry.register("ApiRequestTestResult", z.object({
    httpStatus: z.number().int().nullable(),
    durationMs: z.number().int(),
    outcome: OutcomeSchema,
    reason: FailureReasonSchema.optional(),
    outputs: z.record(z.string(), z.unknown()).describe("The declared outputs projected to their types: what a routine step would get."),
    mismatches: z.array(z.string()).describe("Required outputs the response left absent."),
    body: z.unknown().nullable().describe("The parsed JSON body cut down to 16 KB; null when empty or not JSON."),
    bodyTruncated: z.boolean(),
  }));

  const json = <T>(schema: T) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const connectionResponse = (description: string) => ({ description, content: json(z.object({ connection: ApiConnectionSchema })) });
  const base = { tags: ["Settings"], security: security.workspaceAdminSecurity };

  registry.registerPath({
    ...base,
    method: "get",
    path: "/api/v1/settings/api-connections",
    summary: "List workspace API connections",
    operationId: "listApiConnections",
    responses: {
      200: { description: "API connections returned", content: json(z.object({ connections: z.array(ApiConnectionSchema) })) },
      401: errorResponse("Authentication required"),
    },
  });

  registry.registerPath({
    ...base,
    method: "post",
    path: "/api/v1/settings/api-connections",
    summary: "Create a workspace API connection",
    operationId: "createApiConnection",
    request: { body: { required: true, content: json(ApiConnectionCreateSchema) } },
    responses: {
      201: connectionResponse("API connection created"),
      400: errorResponse("Request validation failed"),
      401: errorResponse("Authentication required"),
      409: errorResponse("Connection name already exists"),
    },
  });

  registry.registerPath({
    ...base,
    method: "get",
    path: "/api/v1/settings/api-connections/{connectionId}",
    summary: "Get a workspace API connection",
    operationId: "getApiConnection",
    request: { params: ConnectionParams },
    responses: {
      200: connectionResponse("API connection returned"),
      401: errorResponse("Authentication required"),
      404: errorResponse("API connection not found"),
    },
  });

  registry.registerPath({
    ...base,
    method: "patch",
    path: "/api/v1/settings/api-connections/{connectionId}",
    summary: "Update a workspace API connection",
    description: "Changes only the fields sent; an omitted credential is kept. While a credential is stored, an update that changes the base URL's origin, the auth scheme or the auth header name must send a new credential in the same request, or it is refused with `credential_required`: a stored credential is only ever sent where it was entered for.",
    operationId: "updateApiConnection",
    request: { params: ConnectionParams, body: { required: true, content: json(ApiConnectionUpdateSchema) } },
    responses: {
      200: connectionResponse("API connection updated"),
      400: errorResponse("Request validation failed, or `credential_required`: the update moves the stored credential to another origin, scheme or header without a new one"),
      401: errorResponse("Authentication required"),
      404: errorResponse("API connection not found"),
      409: errorResponse("Connection name already exists"),
    },
  });

  registry.registerPath({
    ...base,
    method: "delete",
    path: "/api/v1/settings/api-connections/{connectionId}",
    summary: "Delete a workspace API connection",
    operationId: "deleteApiConnection",
    request: { params: ConnectionParams },
    responses: {
      204: { description: "API connection deleted" },
      401: errorResponse("Authentication required"),
      404: errorResponse("API connection not found"),
      409: errorResponse("An agent skill uses the connection"),
    },
  });

  registry.registerPath({
    ...base,
    method: "post",
    path: "/api/v1/settings/api-connections/{connectionId}/test-request",
    summary: "Send a test request through an API connection",
    description: "Sends one real request the way an API request skill would and returns its outcome, the declared outputs and the parsed body. A method other than GET acts on the target.",
    operationId: "testApiConnectionRequest",
    request: { params: ConnectionParams, body: { required: true, content: json(ApiRequestTestSchema) } },
    responses: {
      200: { description: "Test request settled", content: json(ApiRequestTestResultSchema) },
      400: errorResponse("Request validation failed"),
      401: errorResponse("Authentication required"),
      404: errorResponse("API connection not found"),
    },
  });
};
