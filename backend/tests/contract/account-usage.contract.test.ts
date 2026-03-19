import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("account usage contract", () => {
  it("returns account-wide daily and monthly usage for the session user", async () => {
    const { app, dependencies } = createTestApp();
    const register = await request(app).post("/api/v1/auth/register").send({
      email: "usage-contract@example.com",
      password: "verysecurepassword",
    });
    const cookie = register.headers["set-cookie"][0];
    const accountId = register.body.userId as string;

    const workspaces = await request(app)
      .get("/api/v1/workspace")
      .set("Cookie", cookie);
    const workspaceId = workspaces.body.workspaces[0].id as string;

    await dependencies.usageCaptureService.observe({
      operationKey: "usage-contract-1",
      accountId,
      workspaceId,
      sourceArea: "chat",
      operationType: "chat_answer",
      model: "gpt-5-mini",
      eventStatus: "success",
      usageAvailable: true,
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      occurredAt: new Date("2026-03-19T12:00:00.000Z"),
    });

    const response = await request(app)
      .get("/api/v1/account/usage")
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["currentMonth", "daily", "monthly", "today"]);
    expect(response.body.daily[0]).toEqual({
      date: expect.any(String),
      totals: {
        promptTokens: expect.any(Number),
        completionTokens: expect.any(Number),
        totalTokens: expect.any(Number),
      },
    });
    expect(response.body.monthly[0]).toEqual({
      month: expect.any(String),
      totals: {
        promptTokens: expect.any(Number),
        completionTokens: expect.any(Number),
        totalTokens: expect.any(Number),
      },
    });
  });

  it("documents the account usage endpoint in the shared OpenAPI contract", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/account/usage:");
    expect(spec).toContain("AccountUsageSummary:");
  });
});
