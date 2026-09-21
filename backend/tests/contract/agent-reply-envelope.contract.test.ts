import { describe, expect, it } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import type { AgentConverseAskResult } from "../../src/modules/chat/contracts/index.js";
import { createTestApp, issueTestSession } from "../support/testApp.js";

const ENVELOPE_CORE_FIELDS = ["conversationId", "answerCoverage", "ownership"] as const;

type SchemaNode = {
  $ref?: string;
  allOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
};

const resolve = (schemas: Record<string, SchemaNode>, node: SchemaNode): SchemaNode =>
  node.$ref ? schemas[node.$ref.replace("#/components/schemas/", "")] : node;

/** Flattens `allOf` (with `$ref` members) into one property/required view. */
const flatten = (schemas: Record<string, SchemaNode>, node: SchemaNode): { properties: Record<string, SchemaNode>; required: string[] } => {
  const resolved = resolve(schemas, node);
  if (resolved.allOf) {
    return resolved.allOf.map((member) => flatten(schemas, member)).reduce(
      (merged, part) => ({
        properties: { ...merged.properties, ...part.properties },
        required: [...merged.required, ...part.required],
      }),
      { properties: {}, required: [] },
    );
  }
  return { properties: resolved.properties ?? {}, required: resolved.required ?? [] };
};

const jsonResponseSchema = (document: ReturnType<typeof createOpenApiDocument>, path: string): SchemaNode => {
  const operation = document.paths?.[path]?.post as {
    responses?: Record<string, { content?: Record<string, { schema?: SchemaNode }> }>;
  } | undefined;
  const schema = operation?.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!schema) {
    throw new Error(`No JSON 200 response schema registered for POST ${path}`);
  }
  return schema;
};

const createAppWithMcpConverse = () =>
  createTestApp({
    chatGateway: {
      async answer(input) {
        return `agent:${input.query}`;
      },
      async *streamAnswer() {
        yield "unused";
      },
    },
    applicationRouteMounts: [{
      path: "/api/v1/mcp/converse",
      createRouter: (dependencies) => createMcpConverseRoutes(dependencies, buildMcpConverseServices(dependencies)),
    }],
  });

describe("agent reply envelope contract (SC-004)", () => {
  const document = createOpenApiDocument();
  const schemas = (document.components?.schemas ?? {}) as Record<string, SchemaNode>;

  it("publishes the envelope core once and references it from both operations", () => {
    const core = schemas.AgentReplyEnvelopeCore;
    expect(core).toBeDefined();
    expect(core.required).toEqual(expect.arrayContaining([...ENVELOPE_CORE_FIELDS]));
    expect(core.properties?.answerCoverage).toEqual({ $ref: "#/components/schemas/AnswerCoverageAssessment" });
    expect(core.properties?.ownership).toEqual({ $ref: "#/components/schemas/ChatOwnershipAck" });
    expect(core.properties?.routine).toEqual({ $ref: "#/components/schemas/RoutineTurnState" });
    expect(core.properties?.traceId).toMatchObject({ type: "string" });
    expect(core.required).not.toContain("routine");
    expect(core.required).not.toContain("traceId");

    const routineState = schemas.RoutineTurnState;
    expect(routineState.required).toEqual(expect.arrayContaining(["name", "status", "pendingInput"]));
    expect(routineState.properties?.status).toMatchObject({
      enum: ["active", "waiting_for_input", "waiting_for_approval", "completed", "abandoned"],
    });
    expect(schemas.RoutinePendingInput.required).toEqual(expect.arrayContaining(["key", "type", "required"]));
    expect(schemas.RoutinePendingInput.properties?.type).toMatchObject({
      enum: ["text", "number", "boolean", "email", "date"],
    });
  });

  it("declares the core on POST /api/v1/mcp/converse/ask and keeps answer.{text,citations}", () => {
    const askSchema = resolve(schemas, jsonResponseSchema(document, "/api/v1/mcp/converse/ask"));
    expect(askSchema.allOf?.[0]).toEqual({ $ref: "#/components/schemas/AgentReplyEnvelopeCore" });
    const ask = flatten(schemas, askSchema);

    expect(ask.required).toEqual(expect.arrayContaining([...ENVELOPE_CORE_FIELDS, "answer"]));
    const answer = ask.properties.answer;
    expect(answer.required).toEqual(expect.arrayContaining(["text", "citations"]));
    expect(answer.properties?.citations).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/Citation" },
    });
  });

  it("declares the core on POST /api/v1/agents/{agentId}/chat and keeps answer as a string", () => {
    const response = resolve(schemas, jsonResponseSchema(document, "/api/v1/agents/{agentId}/chat"));
    const [turnResponse, bootstrapResponse] = response.oneOf ?? response.anyOf ?? [];
    expect(turnResponse).toBeDefined();
    expect(bootstrapResponse).toEqual({ $ref: "#/components/schemas/ChatBootstrapResponse" });

    expect(turnResponse).toEqual({ $ref: "#/components/schemas/AgentChannelChatTurnResponse" });
    const turn = flatten(schemas, turnResponse);
    expect(turn.required).toEqual(expect.arrayContaining([...ENVELOPE_CORE_FIELDS, "answer", "citations"]));
    expect(turn.properties.answer).toMatchObject({ type: "string" });
    expect(turn.properties.citations).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/Citation" },
    });
  });

  it("returns the envelope core on a live REST agent chat turn", async () => {
    const { app, dependencies } = createAppWithMcpConverse();
    const session = await issueTestSession(app);
    const agent = await dependencies.agentService.resolve(session.workspaceId);
    const credential = await dependencies.accessGrantService.issueGrant({
      agentId: agent.id,
      workspaceId: session.workspaceId,
      principalKind: "agent-api",
      channel: "agent-api",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await request(app)
      .post(`/api/v1/agents/${agent.id}/chat`)
      .set("Authorization", `Bearer ${credential.token}`)
      .send({ message: "Hello", stream: false });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId: expect.any(String),
      answer: expect.any(String),
      citations: expect.any(Array),
      answerCoverage: { availability: expect.any(String) },
      ownership: { state: "ai_owned", suppressed: false },
    });
    expect(response.body).not.toHaveProperty("debug");
  });

  it("returns the envelope core on a live MCP converse ask", async () => {
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
    const exchange = await request(app)
      .post("/api/v1/mcp/converse/session")
      .send({ launchToken: issued.token });

    const ask = await request(app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${exchange.body.sessionToken}`)
      .send({ message: "Hello" });

    expect(ask.status).toBe(200);
    const body = ask.body as AgentConverseAskResult;
    expect(body).toMatchObject({
      conversationId: exchange.body.conversationId,
      answer: { text: expect.any(String), citations: expect.any(Array) },
      answerCoverage: { availability: expect.any(String) },
      ownership: { state: "ai_owned", suppressed: false },
    });
  });
});
