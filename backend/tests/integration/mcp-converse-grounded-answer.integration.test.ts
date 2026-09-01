import { describe, expect, it } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { createTestApp } from "../support/testApp.js";

const createAppWithMcpConverse = () =>
  createTestApp({
    applicationRouteMounts: [{
      path: "/api/v1/mcp/converse",
      createRouter: (dependencies) => createMcpConverseRoutes(dependencies, buildMcpConverseServices(dependencies)),
    }],
  });

describe("MCP agent credential direct retrieval", () => {
  it("does not expose a grounded-answer transport", async () => {
    const ctx = createAppWithMcpConverse();

    const response = await request(ctx.app)
      .post("/api/v1/mcp/converse/grounded-answer")
      .send({ query: "Which policy applies?", maxResults: 4 });

    expect(response.status).toBe(404);
  });
});
