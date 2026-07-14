import { readFileSync } from "node:fs";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { routineValidationCodes } from "../../src/modules/routines/public.js";

interface RoutineValidationResultOpenApiSchema {
  properties?: {
    diagnostics?: {
      items?: {
        properties?: {
          code?: {
            enum?: string[];
          };
        };
      };
    };
  };
}

describe("openapi contract", () => {
  it("matches the checked-in generated yaml", () => {
    const yamlSpec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(parse(yamlSpec)).toEqual(createOpenApiDocument());
  });

  it("uses the configured session cookie name when generating the document", () => {
    const document = createOpenApiDocument({ sessionCookieName: "custom_session" });
    const sessionCookie = document.components?.securitySchemes?.sessionCookie;

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie && "name" in sessionCookie ? sessionCookie.name : undefined).toBe("custom_session");
  });

  it("does not advertise a fixed anonymous chat session cookie name", () => {
    const document = createOpenApiDocument();
    const paths = document.paths ?? {};

    expect(document.components?.securitySchemes).not.toHaveProperty("anonymousSessionCookie");
    expect(paths["/api/v1/public/chat/{token}"]?.post).not.toHaveProperty("security");
    expect(paths["/api/v1/public/chat/{token}"]?.get).not.toHaveProperty("security");
    expect(paths["/api/v1/public/chat/{token}/history/{conversationId}"]?.get).not.toHaveProperty("security");
    expect(paths["/api/v1/public/chat/{token}/tail/{conversationId}"]?.get).not.toHaveProperty("security");
    expect(paths["/api/v1/public/chat/{token}/events/{conversationId}"]?.get).not.toHaveProperty("security");
  });

  it("advertises bearer auth separately from the session cookie scheme", () => {
    const document = createOpenApiDocument();
    const schemes = document.components?.securitySchemes ?? {};
    const bearerAuth = schemes.bearerAuth;
    const sessionCookie = schemes.sessionCookie;

    expect(bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "APIKey",
    });
    expect(sessionCookie).toBeDefined();
    expect(bearerAuth).not.toEqual(sessionCookie);
    expect(document.paths?.["/api/v1/document/"]?.post?.security).toEqual([{ bearerAuth: [] }]);
  });

  it("keeps the routine validation code enum in sync with the validator", () => {
    const document = createOpenApiDocument();
    const schema = document.components?.schemas?.RoutineValidationResult as
      | RoutineValidationResultOpenApiSchema
      | undefined;

    expect(schema?.properties?.diagnostics?.items?.properties?.code?.enum).toEqual([...routineValidationCodes]);
  });

  it("advertises portable routine markdown authoring endpoints", () => {
    const document = createOpenApiDocument();
    const paths = document.paths ?? {};

    expect(paths["/api/v1/agents/{agentId}/routines/{routineId}/portable"]?.get).toMatchObject({
      operationId: "getAgentRoutinePortableDocument",
      security: [{ bearerAuth: [] }],
      responses: expect.objectContaining({ "200": expect.any(Object), "422": expect.any(Object) }),
    });
    expect(paths["/api/v1/agents/{agentId}/routines/{routineId}/portable"]?.put).toMatchObject({
      operationId: "updateAgentRoutinePortableDocument",
      responses: expect.objectContaining({ "400": expect.any(Object), "422": expect.any(Object) }),
    });
    expect(paths["/api/v1/agents/{agentId}/routines/portable"]?.post).toMatchObject({
      operationId: "createAgentRoutinePortableDocument",
      responses: expect.objectContaining({ "201": expect.any(Object), "400": expect.any(Object), "409": expect.any(Object), "422": expect.any(Object) }),
    });
    expect(paths["/api/v1/agents/{agentId}/routines"]?.post?.responses).toEqual(expect.objectContaining({
      "201": expect.any(Object),
      "409": expect.any(Object),
    }));
    expect(paths["/api/v1/routines/portable/canonicalize"]?.post).toMatchObject({
      operationId: "canonicalizeRoutinePortableDocument",
      security: [{ bearerAuth: [] }],
      responses: expect.objectContaining({ "200": expect.any(Object), "400": expect.any(Object) }),
    });
    expect(document.components?.schemas).toHaveProperty("PortableRoutineDocumentEnvelope");
    expect(document.components?.schemas).toHaveProperty("PortableRoutineParseDiagnosticsResponse");
  });

  it("advertises the account usage trends endpoint as a session-authenticated account report", () => {
    const document = createOpenApiDocument();
    const operation = document.paths?.["/api/v1/account/usage-trends"]?.get;

    expect(operation).toMatchObject({
      operationId: "getAccountUsageTrends",
      tags: ["Account"],
      security: [{ sessionCookie: [] }],
    });
    expect(operation?.responses).toHaveProperty("200");
    expect(operation?.responses).toHaveProperty("400");
    expect(operation?.responses).toHaveProperty("401");
  });

  it("advertises dashboard and public conversation tail response shapes", () => {
    const document = createOpenApiDocument();
    const schemas = document.components?.schemas ?? {};
    const dashboardTail = schemas.ChatConversationTail;
    const publicTail = schemas.PublicChatConversationTail;

    expect(document.paths?.["/api/v1/history/chat/{conversationId}/tail"]?.get).toMatchObject({
      operationId: "tailHistoryConversation",
      security: [{ bearerAuth: [] }],
    });
    expect(document.paths?.["/api/v1/public/chat/{token}/tail/{conversationId}"]?.get).toMatchObject({
      operationId: "tailPublicChatHistoryConversation",
    });
    expect(dashboardTail).toMatchObject({
      properties: expect.objectContaining({
        messages: expect.any(Object),
        cursor: expect.any(Object),
        ownership: expect.any(Object),
      }),
    });
    expect(publicTail).toMatchObject({
      properties: expect.objectContaining({
        messages: expect.any(Object),
        cursor: expect.any(Object),
      }),
    });
    expect(publicTail).not.toMatchObject({
      properties: expect.objectContaining({
        ownership: expect.any(Object),
      }),
    });
  });
});
