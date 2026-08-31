import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("workspace MCP context contract", () => {
  it("does not expose the retired workspace MCP context endpoint", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/api/v1/workspace/mcp/context");

    expect(response.status).toBe(404);
  });

});
