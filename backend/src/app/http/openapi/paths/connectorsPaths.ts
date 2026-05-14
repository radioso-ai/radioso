import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerConnectorsPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectors",
    tags: ["Connectors"],
    summary: "List connectors for the authenticated workspace",
    operationId: "listConnectors",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    responses: {
      200: {
        description: "Connectors returned",
        content: {
          "application/json": {
            schema: schemas.ConnectorListResponseSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/connectors/{connectorId}",
    tags: ["Connectors"],
    summary: "Get connector detail",
    operationId: "getConnectorDetail",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.connectorIdPathParamsSchema,
    },
    responses: {
      200: {
        description: "Connector detail returned",
        content: {
          "application/json": {
            schema: schemas.ConnectorDetailSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Connector not found",
        content: {
          "application/json": {
            schema: z.object({ error: z.literal("Connector not found") }).openapi("ConnectorNotFoundResponse"),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/v1/connectors/{connectorId}",
    tags: ["Connectors"],
    summary: "Save connector config",
    operationId: "updateConnectorConfig",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.connectorIdPathParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: schemas.ConnectorConfigUpdateSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Connector config saved",
        content: {
          "application/json": {
            schema: schemas.ConnectorDetailSchema,
          },
        },
      },
      400: {
        description: "Connector config invalid",
        content: {
          "application/json": {
            schema: schemas.ConnectorValidationErrorSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Connector not found",
        content: {
          "application/json": {
            schema: z.object({ error: z.literal("Connector not found") }),
          },
        },
      },
      409: {
        description: "Connector identity conflict",
        content: {
          "application/json": {
            schema: schemas.ConnectorConflictSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/connectors/{connectorId}/enable",
    tags: ["Connectors"],
    summary: "Enable a connector",
    operationId: "enableConnector",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.connectorIdPathParamsSchema,
    },
    responses: {
      200: {
        description: "Connector enabled",
        content: {
          "application/json": {
            schema: schemas.ConnectorDetailSchema,
          },
        },
      },
      400: {
        description: "Connector config invalid",
        content: {
          "application/json": {
            schema: schemas.ConnectorValidationErrorSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Connector not found",
        content: {
          "application/json": {
            schema: z.object({ error: z.literal("Connector not found") }),
          },
        },
      },
      409: {
        description: "Connector identity conflict",
        content: {
          "application/json": {
            schema: schemas.ConnectorConflictSchema,
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/connectors/{connectorId}/disable",
    tags: ["Connectors"],
    summary: "Disable a connector",
    operationId: "disableConnector",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: {
      params: schemas.connectorIdPathParamsSchema,
    },
    responses: {
      200: {
        description: "Connector disabled",
        content: {
          "application/json": {
            schema: schemas.ConnectorDetailSchema,
          },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      404: {
        description: "Connector not found",
        content: {
          "application/json": {
            schema: z.object({ error: z.literal("Connector not found") }),
          },
        },
      },
    },
  });
};
