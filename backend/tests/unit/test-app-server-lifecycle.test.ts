import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("test app HTTP lifecycle", () => {
  it("keeps one reachable listener across repeated requests", async () => {
    const { app } = createTestApp();

    for (let index = 0; index < 500; index += 1) {
      const response = await request(app).get("/health");
      expect(response.status).toBe(200);
    }
  });
});
