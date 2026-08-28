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
  it("advertises the browser-safe realtime enablement flag on workspace route resolution", () => {
    const document = createOpenApiDocument();
    const schema = document.components?.schemas?.WorkspaceRouteResolutionResponse as {
      properties?: Record<string, unknown>;
      required?: string[];
    } | undefined;

    expect(schema?.properties?.realtimeEnabled).toEqual({ type: "boolean" });
    expect(schema?.required).toEqual(expect.arrayContaining(["realtimeEnabled"]));
  });

  it("documents the eval suite batch run so the SDK and coverage map can see it", () => {
    const suiteRun = createOpenApiDocument().paths?.["/api/v1/evals/cases/run"]?.post;

    expect(suiteRun).toMatchObject({
      operationId: "runEvalCases",
      description: expect.stringContaining("sequentially"),
      responses: { "200": expect.any(Object) },
    });
  });

  it("publishes the complete discriminated Eval assertion contract", () => {
    const schemas = createOpenApiDocument().components?.schemas ?? {};
    const assertions = schemas.EvalAssertion as {
      oneOf?: Array<{
        properties?: Record<string, unknown>;
        required?: string[];
      }>;
    } | undefined;

    expect(assertions?.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          type: { type: "string", enum: ["retrieval_top_k_includes_document"] },
          documentId: { type: "string", format: "uuid" },
          k: { type: "integer", minimum: 1, maximum: 100 },
        }),
        required: expect.arrayContaining(["type", "documentId", "k"]),
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          type: { type: "string", enum: ["llm_judge"] },
          expectedAnswer: { type: "string", minLength: 1, maxLength: 8000 },
        }),
        required: expect.arrayContaining(["type", "expectedAnswer"]),
      }),
    ]));
  });

  it("documents every live workspace Eval route with a distinct operation", () => {
    const paths = createOpenApiDocument().paths ?? {};
    const expectedOperations = {
      "/api/v1/evals/snapshots": { post: "createEvalSnapshot" },
      "/api/v1/evals/snapshots/{id}": { get: "getEvalSnapshot" },
      "/api/v1/evals/cases": { post: "createEvalCase", get: "listEvalCases" },
      "/api/v1/evals/cases/by-source-message/{assistantMessageId}": {
        get: "getEvalCaseBySourceMessage",
        put: "getOrCreateEvalCaseBySourceMessage",
      },
      "/api/v1/evals/cases/{id}": {
        get: "getEvalCase",
        patch: "renameEvalCase",
        delete: "deleteEvalCase",
      },
      "/api/v1/evals/cases/{id}/assertions": { put: "replaceEvalCaseAssertions" },
      "/api/v1/evals/cases/{id}/runs": { post: "createEvalCaseRun" },
      "/api/v1/evals/cases/run": { post: "runEvalCases" },
      "/api/v1/evals/runs": { post: "createEvalRun" },
    } as const;

    for (const [path, methods] of Object.entries(expectedOperations)) {
      for (const [method, operationId] of Object.entries(methods)) {
        const operation = paths[path]?.[method as keyof typeof paths[string]];
        expect(operation).toMatchObject({
          operationId,
          security: expect.arrayContaining([{ bearerAuth: [] }]),
        });
        expect(operation?.responses).toHaveProperty("401");
        expect(operation?.responses).toHaveProperty("403");
      }
    }
  });

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
    expect(document.components?.schemas?.RegisterResponse).toMatchObject({
      properties: {
        requiresEmailVerification: { type: "boolean" },
      },
    });
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

  it("advertises the hosted production servers before local development, and a Radioso-branded title", () => {
    const document = createOpenApiDocument();

    expect(document.info.title).toBe("Radioso API");
    expect(document.info.description).toEqual(expect.any(String));
    expect(document.info.description).not.toMatch(/radioso backend/i);
    expect(document.servers).toEqual([
      { url: "https://api.radioso.ai", description: "Production" },
      { url: "https://api-us.radioso.ai", description: "Production (US)" },
      { url: "http://localhost:8080", description: "Local development" },
    ]);
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
