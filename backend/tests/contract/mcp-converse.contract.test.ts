import { describe, expect, it } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { createTestApp } from "../support/testApp.js";

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
