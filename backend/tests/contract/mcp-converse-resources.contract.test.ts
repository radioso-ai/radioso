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

describe("MCP agent credential chat-only contract", () => {
  it("does not register direct retrieval or resource paths", () => {
    const document = createOpenApiDocument();

    expect(document.paths?.["/api/v1/mcp/converse/grounded-answer"]).toBeUndefined();
    expect(document.paths?.["/api/v1/mcp/converse/resources"]).toBeUndefined();
    expect(document.paths?.["/api/v1/mcp/converse/resources/{resourceId}"]).toBeUndefined();
  });

  it("returns not found for direct retrieval and resource paths", async () => {
    const { app } = createAppWithMcpConverse();

    const grounded = await request(app)
      .post("/api/v1/mcp/converse/grounded-answer")
      .send({});
    const list = await request(app)
      .get("/api/v1/mcp/converse/resources");
    const read = await request(app)
      .get("/api/v1/mcp/converse/resources/not-a-session");

    expect(grounded.status).toBe(404);
    expect(list.status).toBe(404);
    expect(read.status).toBe(404);
  });
});
