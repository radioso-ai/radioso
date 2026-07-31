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
  it("documents structured Quality closure and message-scoped Eval convenience", () => {
    const document = createOpenApiDocument();
    const paths = document.paths ?? {};
    const qualityList = paths["/api/v1/quality/turns"]?.get;
    const qualityTriage = paths["/api/v1/quality/turns/{assistantMessageId}/triage"]?.put;
    const evalMessagePath = paths["/api/v1/evals/cases/by-source-message/{assistantMessageId}"];
    const qualityQueryNames = (qualityList?.parameters ?? [])
      .filter((parameter) => "name" in parameter)
      .map((parameter) => parameter.name);

    expect(qualityQueryNames).toEqual(expect.arrayContaining([
      "resolutionReason",
      "resolutionFrom",
      "resolutionTo",
    ]));
    expect(qualityTriage).toMatchObject({
      operationId: "setQualityTurnTriage",
      description: expect.stringContaining("optional structured reason"),
      responses: {
        "200": expect.any(Object),
        "409": expect.any(Object),
      },
    });
    expect(document.components?.schemas).toMatchObject({
      QualityResolutionReason: expect.any(Object),
      QualityResolution: expect.any(Object),
      QualityResolutionInput: {
        properties: {
          note: expect.any(Object),
        },
      },
      QualityTriageRecord: {
        properties: {
          resolution: {
            anyOf: expect.arrayContaining([
              { $ref: "#/components/schemas/QualityResolution" },
              { type: "null" },
            ]),
          },
        },
      },
      QualityTriageConflictResponse: expect.any(Object),
      QualityVerification: expect.any(Object),
      LowQualityTurn: {
        properties: {
          verification: {
            anyOf: expect.arrayContaining([
              { $ref: "#/components/schemas/QualityVerification" },
              { type: "null" },
            ]),
          },
        },
      },
      SetQualityTriageRequest: {
        properties: {
          resolution: {
            anyOf: expect.arrayContaining([
              { $ref: "#/components/schemas/QualityResolutionInput" },
              { type: "null" },
            ]),
          },
        },
      },
      EvalMessageCaseLookup: expect.any(Object),
      EvalMessageCaseMutationResult: expect.any(Object),
    });
    expect(document.components?.schemas?.QualityTriageRecord)
      .not.toHaveProperty("properties.resolution.allOf");
    expect(document.components?.schemas?.LowQualityTurn)
      .not.toHaveProperty("properties.verification.allOf");
    expect(document.components?.schemas?.SetQualityTriageRequest)
      .not.toHaveProperty("properties.resolution.allOf");
    expect(document.components?.schemas?.SetQualityTriageRequest)
      .not.toHaveProperty("required", expect.arrayContaining(["resolution"]));
    expect(document.components?.schemas?.QualityResolutionInput)
      .not.toHaveProperty("required", expect.arrayContaining(["note"]));
    expect(evalMessagePath?.get).toMatchObject({
      operationId: "getEvalCaseBySourceMessage",
      responses: {
        "200": expect.any(Object),
        "404": expect.any(Object),
      },
    });
    expect(evalMessagePath?.put).toMatchObject({
      operationId: "getOrCreateEvalCaseBySourceMessage",
      responses: {
        "200": expect.any(Object),
        "201": expect.any(Object),
      },
    });
  });

  it("documents registration availability and edition-gated organization creation", () => {
    const document = createOpenApiDocument();
    const paths = document.paths ?? {};

    expect(paths["/api/v1/auth/registration"]?.get).toMatchObject({
      operationId: "getRegistrationAvailability",
      responses: { "200": expect.any(Object) },
    });
    expect(paths["/api/v1/auth/register"]?.post?.responses).toHaveProperty("403");
    expect(paths["/api/v1/account/accounts"]?.post).toMatchObject({
      operationId: "createAdditionalOrganization",
      responses: {
        "201": expect.any(Object),
        "403": expect.any(Object),
        "429": expect.any(Object),
      },
    });
  });

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

  it("documents typed status events without modeling the SSE body as one JSON object", () => {
    const document = createOpenApiDocument();
    const schemas = document.components?.schemas ?? {};
    const streamSchema = document.paths?.["/api/v1/assistant/chat"]?.post
      ?.responses?.["200"]?.content?.["text/event-stream"]?.schema;

    expect(schemas.ChatStatusStage).toEqual({
      type: "string",
      enum: ["interpreting", "searching", "composing"],
    });
    expect(schemas.ChatStatusEvent).toMatchObject({
      type: "object",
      properties: {
        stage: { $ref: "#/components/schemas/ChatStatusStage" },
      },
      required: ["stage"],
    });
    // The generator registers the SSE body as a named component; assert through the ref.
    expect(streamSchema).toEqual({ $ref: "#/components/schemas/AssistantChatSseStream" });
    expect(schemas.AssistantChatSseStream).toMatchObject({
      type: "string",
      description: expect.stringContaining("status(interpreting)"),
    });
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
    expect(paths["/api/v1/agents/{agentId}/routines/{routineId}/portable"]?.get?.responses?.["422"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/PortableRoutineParseDiagnosticsResponse",
    });
    expect(paths["/api/v1/agents/{agentId}/routines/{routineId}/portable"]?.put).toMatchObject({
      operationId: "updateAgentRoutinePortableDocument",
      responses: expect.objectContaining({ "400": expect.any(Object), "422": expect.any(Object) }),
    });
    expect(paths["/api/v1/agents/{agentId}/routines/{routineId}/portable"]?.put?.responses?.["422"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/PortableRoutineSaveRejectedResponse",
    });
    expect(paths["/api/v1/agents/{agentId}/routines/portable"]?.post).toMatchObject({
      operationId: "createAgentRoutinePortableDocument",
      responses: expect.objectContaining({ "201": expect.any(Object), "400": expect.any(Object), "409": expect.any(Object), "422": expect.any(Object) }),
    });
    expect(paths["/api/v1/agents/{agentId}/routines/portable"]?.post?.responses?.["422"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/PortableRoutineSaveRejectedResponse",
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
    expect(document.components?.schemas?.PortableRoutineSaveRejectedResponse).toEqual({
      oneOf: [
        { $ref: "#/components/schemas/RoutineDefinitionPublishRejectedResponse" },
        { $ref: "#/components/schemas/PortableRoutineParseDiagnosticsResponse" },
      ],
    });
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
