import { describe, expect, it } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { createTestApp, issueTestSession } from "../support/testApp.js";

const createAppWithMcpConverse = () =>
  createTestApp({
    applicationRouteMounts: [{
      path: "/api/v1/mcp/converse",
      createRouter: (dependencies) => createMcpConverseRoutes(dependencies, buildMcpConverseServices(dependencies)),
    }],
  });

describe("MCP converse HTTP contract", () => {
  it("registers US1 OpenAPI paths", () => {
    const document = createOpenApiDocument();

    expect(document.paths?.["/api/v1/mcp/converse/session"]?.post).toBeDefined();
    expect(document.paths?.["/api/v1/mcp/converse/session/validate"]?.post).toBeDefined();
    expect(document.paths?.["/api/v1/mcp/converse/ask"]?.post).toBeDefined();
    expect(document.paths?.["/api/v1/mcp/converse/session/use"]).toBeUndefined();
    expect(document.components?.securitySchemes?.mcpConverseSessionBearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "McpConverseSession",
    });
    expect(document.paths?.["/api/v1/mcp/converse/ask"]?.post?.security).toEqual([
      { mcpConverseSessionBearerAuth: [] },
    ]);
    expect(document.paths?.["/api/v1/agents/{agentId}/chat"]?.post?.security).toEqual([
      { agentChannelBearerAuth: [] },
    ]);
    expect(document.components?.schemas?.AgentChannelCredentialMetadata).toMatchObject({
      properties: { expiresAt: { type: "string", format: "date-time" } },
      required: expect.arrayContaining(["expiresAt"]),
    });
    expect(document.paths?.["/api/v1/agents/{agentId}/chat"]?.post?.responses).toMatchObject({
      "429": {
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
      },
    });
    for (const path of [
      "/api/v1/mcp/converse/session",
      "/api/v1/mcp/converse/session/validate",
      "/api/v1/mcp/converse/ask",
    ] as const) {
      expect(document.paths?.[path]?.post?.responses).toMatchObject({
        "429": {
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
      });
    }
    expect(document.paths?.["/api/v1/mcp/converse/session"]?.post?.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: {
            properties: {
              client: {
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 128 },
                  version: { type: "string", minLength: 1, maxLength: 64 },
                },
              },
            },
          },
        },
      },
    });
    expect(document.paths?.["/api/v1/mcp/converse/session/validate"]?.post?.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: {
            properties: {
              sessionToken: { type: "string", minLength: 1, maxLength: 2048 },
            },
          },
        },
      },
    });
  });

  it("publishes the tool catalog path and the message-or-routine ask body (US2)", () => {
    const document = createOpenApiDocument();

    const tools = document.paths?.["/api/v1/mcp/converse/tools"]?.get;
    expect(tools?.operationId).toBe("getMcpConverseTools");
    expect(tools?.security).toEqual([{ mcpConverseSessionBearerAuth: [] }]);
    expect(tools?.responses).toMatchObject({
      "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/McpConverseToolsResponse" } } } },
      "429": { content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
    });
    expect(document.components?.schemas?.McpConverseToolsResponse).toMatchObject({
      required: ["agent", "tools"],
      properties: {
        agent: { required: ["name", "description"] },
        tools: { items: { $ref: "#/components/schemas/AgentToolDescriptor" } },
      },
    });
    expect(document.components?.schemas?.AgentToolDescriptor).toMatchObject({
      required: ["toolName", "description", "inputSchema", "routineLineageId"],
      properties: { inputSchema: { $ref: "#/components/schemas/AgentToolInputSchema" } },
    });
    expect(document.components?.schemas?.AgentToolInputSchema).toMatchObject({
      required: ["type", "properties", "required", "additionalProperties"],
      properties: {
        properties: {
          additionalProperties: {
            properties: {
              type: { enum: ["string", "number", "boolean"] },
              format: { enum: ["email", "date"] },
            },
          },
        },
      },
    });

    const ask = document.paths?.["/api/v1/mcp/converse/ask"]?.post;
    expect(ask?.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: {
            properties: {
              message: { type: "string", minLength: 1 },
              routine: {
                required: ["toolName", "input"],
                properties: { toolName: { type: "string" }, input: { type: "object" } },
              },
            },
          },
        },
      },
    });
    expect((ask?.requestBody as { content: Record<string, { schema: { required?: string[] } }> }).content["application/json"].schema.required ?? [])
      .not.toContain("message");
    expect(ask?.responses).toMatchObject({
      "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/McpConverseAskResponse" } } } },
      "400": { content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
      "404": { content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
    });
    expect(document.components?.schemas?.McpConverseAskResponse).toMatchObject({
      allOf: [
        { $ref: "#/components/schemas/AgentReplyEnvelopeCore" },
        { required: ["answer"], properties: { answer: { required: ["text", "citations"] } } },
      ],
    });
    expect(document.components?.schemas?.AgentReplyEnvelopeCore).toMatchObject({
      required: expect.arrayContaining(["conversationId", "answerCoverage", "ownership"]),
      properties: { routine: { $ref: "#/components/schemas/RoutineTurnState" } },
    });
    expect(document.components?.schemas?.RoutineTurnState).toMatchObject({
      properties: { toolName: { type: "string" } },
    });

    const restChat = document.paths?.["/api/v1/agents/{agentId}/chat"]?.post;
    expect(document.components?.schemas?.AgentChannelChatRequest).toMatchObject({
      properties: { routine: { required: ["toolName", "input"] } },
    });
    expect(restChat?.responses).toMatchObject({
      "404": { content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
    });
  });

  it("rejects an ask body that carries both a message and a routine, or neither", async () => {
    const { app, dependencies } = createAppWithMcpConverse();
    const session = await issueTestSession(app);
    const agent = await dependencies.agentService.resolve(session.workspaceId);
    const issued = await dependencies.accessGrantService.issueGrant({
      agentId: agent.id,
      workspaceId: session.workspaceId,
      principalKind: "agent-api",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const exchange = await request(app).post("/api/v1/mcp/converse/session").send({ launchToken: issued.token });
    const ask = (body: Record<string, unknown>) =>
      request(app).post("/api/v1/mcp/converse/ask").set("Authorization", `Bearer ${exchange.body.sessionToken}`).send(body);

    const both = await ask({ message: "hi", routine: { toolName: "start_return", input: {} } });
    const neither = await ask({});
    const malformedRoutine = await ask({ routine: { toolName: "start_return" } });

    expect(both.status).toBe(400);
    expect(neither.status).toBe(400);
    expect(malformedRoutine.status).toBe(400);
  });

  it("validates session exchange request bodies", async () => {
    const { app } = createAppWithMcpConverse();

    const response = await request(app)
      .post("/api/v1/mcp/converse/session")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
    });
  });

  it("reuses one conversation for concurrent and renewed exchanges of one MCP credential", async () => {
    const { app, dependencies } = createAppWithMcpConverse();
    const session = await issueTestSession(app);
    const agent = await dependencies.agentService.resolve(session.workspaceId);
    const issued = await dependencies.accessGrantService.issueGrant({
      agentId: agent.id,
      workspaceId: session.workspaceId,
      principalKind: "agent-api",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [first, second] = await Promise.all([
      request(app).post("/api/v1/mcp/converse/session").send({ launchToken: issued.token }),
      request(app).post("/api/v1/mcp/converse/session").send({ launchToken: issued.token }),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.conversationId).toBe(first.body.conversationId);

    const renewed = await request(app)
      .post("/api/v1/mcp/converse/session")
      .send({ launchToken: issued.token });
    expect(renewed.status).toBe(201);
    expect(renewed.body.conversationId).toBe(first.body.conversationId);

    const rotated = await dependencies.accessGrantService.rotateGrant({ grantId: issued.grant.id });
    const afterRotation = await request(app)
      .post("/api/v1/mcp/converse/session")
      .send({ launchToken: rotated.token });
    expect(afterRotation.status).toBe(201);
    expect(afterRotation.body.conversationId).not.toBe(first.body.conversationId);
  });

  it("rejects missing converse session tokens on validate and ask", async () => {
    const { app } = createAppWithMcpConverse();

    const validate = await request(app)
      .post("/api/v1/mcp/converse/session/validate")
      .send({});
    const ask = await request(app)
      .post("/api/v1/mcp/converse/ask")
      .send({ message: "Hello" });

    expect(validate.status).toBe(400);
    expect(ask.status).toBe(401);
  });
});
