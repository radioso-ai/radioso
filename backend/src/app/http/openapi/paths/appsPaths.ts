import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const releaseParams = z.object({ releaseId: z.string().uuid() });
const planParams = z.object({ planId: z.string().uuid() });
const installationParams = z.object({ installationId: z.string().uuid() });

const configurationValue = z.union([z.string(), z.number(), z.boolean()]);
const configuration = z.record(configurationValue);

const release = z.object({
  id: z.string().uuid(),
  appId: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  publisher: z.object({ id: z.string(), name: z.string() }),
  manifestDigest: z.string(),
  artifactDigest: z.string(),
  admissionPolicyVersion: z.string(),
  admittedAt: z.string().datetime(),
});

const releaseDetail = release.extend({
  // The admitted App Spec exactly as the publisher wrote it and admission accepted it.
  // Its schema belongs to the App contract package, so this surface carries the
  // document rather than a second, drifting description of it.
  manifest: z.record(z.unknown()),
});

const plan = z.object({
  planVersion: z.literal(1),
  workspaceId: z.string().uuid(),
  releaseId: z.string().uuid(),
  appId: z.string(),
  version: z.string(),
  manifestDigest: z.string(),
  configuration,
  grants: z.array(z.object({
    kind: z.enum(["permission", "destination", "collection", "contribution"]),
    key: z.string(),
  })),
  destinations: z.array(z.object({
    id: z.string(),
    host: z.string().nullable(),
    protocols: z.array(z.string()),
    // How a bound connection would be applied when this destination is called, which is
    // what the operator is approving alongside the host itself.
    credentials: z.object({
      slotId: z.string(),
      mode: z.enum(["http_basic", "bearer", "header"]),
      required: z.boolean(),
    }).nullable(),
  })),
  storageCollections: z.array(z.string()),
  contributions: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    executionClass: z.string().nullable(),
    availability: z.string(),
    active: z.boolean(),
  })),
  connectionSlots: z.array(z.object({
    slotId: z.string(),
    kind: z.string(),
    required: z.boolean(),
    bound: z.boolean(),
  })),
  targetAgentIds: z.array(z.string().uuid()),
  unresolvedRequirements: z.array(z.object({
    code: z.enum(["configuration_required", "connection_unbound", "destination_host_unresolved"]),
    path: z.string(),
    message: z.string(),
  })),
});

const planRecord = z.object({
  id: z.string().uuid(),
  releaseId: z.string().uuid(),
  checksum: z.string(),
  plan,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
});

const installation = z.object({
  id: z.string().uuid(),
  appId: z.string(),
  state: z.enum([
    "planned", "provisioning", "staged", "testing", "ready",
    "active", "disabled", "failed", "removing", "removed",
  ]),
  activeReleaseId: z.string().uuid().nullable(),
  candidateReleaseId: z.string().uuid().nullable(),
  configuration,
  health: z.record(z.unknown()),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const connection = z.object({
  id: z.string().uuid(),
  slotId: z.string(),
  kind: z.enum(["secret_fields", "generated_secret"]),
  // Non-sensitive slot fields only. Sensitive values are never readable once bound.
  publicFields: z.record(z.string()),
  hasSecret: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  rotatedAt: z.string().datetime().nullable(),
  deletionRequestedAt: z.string().datetime().nullable(),
});

const operation = z.object({
  id: z.string().uuid(),
  installationId: z.string().uuid(),
  kind: z.enum(["install", "disable", "enable", "remove", "dispose_data"]),
  state: z.enum(["running", "completed", "failed", "compensating"]),
  step: z.string().nullable(),
  error: z.object({ reason: z.string(), message: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const lifecycleOutcome = z.object({ installation, operation });

const installationView = z.object({
  installation,
  activeVersion: z.string().nullable(),
  candidateVersion: z.string().nullable(),
  grants: z.array(z.object({
    kind: z.enum(["permission", "destination", "collection", "contribution"]),
    key: z.string(),
    releaseId: z.string().uuid(),
    approvedAt: z.string().datetime(),
  })),
  connections: z.array(connection),
  currentOperation: operation.nullable(),
});

export const registerAppsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
): void => {
  const session = [{ [security.sessionCookieScheme.name]: [] }];
  const json = <T extends z.ZodTypeAny>(description: string, schema: T) =>
    ({ description, content: { "application/json": { schema } } });
  const errors = {
    400: json("Invalid configuration, connection, or request shape", schemas.ErrorResponseSchema),
    401: json("Interactive workspace session required", schemas.ErrorResponseSchema),
    403: json("App administration permission required", schemas.ErrorResponseSchema),
    404: json("Release, plan, or installation not available in this workspace", schemas.ErrorResponseSchema),
    409: json("Stale plan or installation version, conflicting installation, or an unbound connection this change needs", schemas.ErrorResponseSchema),
    503: json("No App runtime or secret encryption key is configured", schemas.ErrorResponseSchema),
  };
  const body = <T extends z.ZodTypeAny>(schema: T) =>
    ({ required: true, content: { "application/json": { schema } } });

  registry.registerPath({
    method: "get", path: "/api/v1/apps/releases", tags: ["Apps"],
    summary: "List the App releases admission has admitted", operationId: "listAppReleases", security: session,
    responses: { 200: json("Installable releases", z.object({ items: z.array(release) })), ...errors },
  });

  registry.registerPath({
    method: "get", path: "/api/v1/apps/releases/{releaseId}", tags: ["Apps"],
    summary: "Inspect an admitted App release", operationId: "getAppRelease", security: session,
    request: { params: releaseParams },
    responses: { 200: json("The admitted release and its App Spec", releaseDetail), ...errors },
  });

  registry.registerPath({
    method: "post", path: "/api/v1/apps/installation-plans", tags: ["Apps"],
    summary: "Plan an installation for review", operationId: "createAppInstallationPlan", security: session,
    request: {
      body: body(z.object({
        releaseId: z.string().uuid(),
        configuration: configuration.optional(),
        targetAgentIds: z.array(z.string().uuid()).optional(),
      })),
    },
    responses: { 201: json("The plan an operator approves, with its checksum", planRecord), ...errors },
  });

  registry.registerPath({
    method: "get", path: "/api/v1/apps/installation-plans/{planId}", tags: ["Apps"],
    summary: "Read a previously created installation plan", operationId: "getAppInstallationPlan", security: session,
    request: { params: planParams },
    responses: { 200: json("The approved plan", planRecord), ...errors },
  });

  registry.registerPath({
    method: "post", path: "/api/v1/apps/installation-plans/{planId}/apply", tags: ["Apps"],
    summary: "Apply an approved installation plan", operationId: "applyAppInstallationPlan", security: session,
    request: {
      params: planParams,
      body: body(z.object({
        checksum: z.string(),
        expectedInstallationVersion: z.number().int().positive().nullable().optional(),
        idempotencyKey: z.string().min(1).max(200),
      })),
    },
    responses: { 201: json("The installation and the lifecycle operation that ran", lifecycleOutcome), ...errors },
  });

  registry.registerPath({
    method: "get", path: "/api/v1/apps/installations", tags: ["Apps"],
    summary: "List this workspace's App installations", operationId: "listAppInstallations", security: session,
    responses: { 200: json("Installations", z.object({ items: z.array(installation) })), ...errors },
  });

  registry.registerPath({
    method: "get", path: "/api/v1/apps/installations/{installationId}", tags: ["Apps"],
    summary: "Read an installation with its grants and connections", operationId: "getAppInstallation", security: session,
    request: { params: installationParams },
    responses: { 200: json("The installation and what it currently holds", installationView), ...errors },
  });

  registry.registerPath({
    method: "get", path: "/api/v1/apps/installations/{installationId}/operations", tags: ["Apps"],
    summary: "List an installation's lifecycle operations", operationId: "listAppInstallationOperations", security: session,
    request: { params: installationParams },
    responses: { 200: json("Recent lifecycle operations", z.object({ items: z.array(operation) })), ...errors },
  });

  registry.registerPath({
    method: "patch", path: "/api/v1/apps/installations/{installationId}/configuration", tags: ["Apps"],
    summary: "Change an installation's configuration values",
    operationId: "updateAppInstallationConfiguration", security: session,
    request: {
      params: installationParams,
      body: body(z.object({ configuration, expectedVersion: z.number().int().positive() })),
    },
    responses: { 200: json("The updated installation", installation), ...errors },
  });

  registry.registerPath({
    method: "post", path: "/api/v1/apps/installations/{installationId}/connections", tags: ["Apps"],
    summary: "Bind a connection slot", operationId: "bindAppConnection", security: session,
    request: {
      params: installationParams,
      body: body(z.object({ slotId: z.string(), values: z.record(z.unknown()).optional() })),
    },
    responses: {
      201: json(
        "The bound connection. `generatedSecret` is present only for a host-minted slot and is returned exactly once.",
        z.object({ connection, generatedSecret: z.string().nullable() }),
      ),
      ...errors,
    },
  });

  for (const action of ["disable", "enable"] as const) {
    registry.registerPath({
      method: "post", path: `/api/v1/apps/installations/{installationId}/${action}`, tags: ["Apps"],
      summary: `${action[0]?.toUpperCase()}${action.slice(1)} an installation`,
      operationId: `${action}AppInstallation`, security: session,
      request: {
        params: installationParams,
        body: body(z.object({ idempotencyKey: z.string().min(1).max(200).optional() })),
      },
      responses: { 200: json("The installation and the lifecycle operation that ran", lifecycleOutcome), ...errors },
    });
  }

  registry.registerPath({
    method: "post", path: "/api/v1/apps/installations/{installationId}/remove", tags: ["Apps"],
    summary: "Remove an installation and dispose of its managed data",
    operationId: "removeAppInstallation", security: session,
    request: {
      params: installationParams,
      body: body(z.object({
        disposition: z.enum(["export", "retain", "delete"]),
        idempotencyKey: z.string().min(1).max(200).optional(),
      })),
    },
    responses: { 200: json("The removed installation and the operation that ran", lifecycleOutcome), ...errors },
  });
};
