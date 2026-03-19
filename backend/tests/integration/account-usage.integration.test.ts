import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("account usage integration", () => {
  it("aggregates usage across multiple workspaces on the same account", async () => {
    const { app, dependencies } = createTestApp();
    const { cookie, workspaceId } = await issueTestToken(app, "usage-multi@example.com");

    const createWorkspace = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", cookie)
      .send({ name: "Second" });
    const secondWorkspaceId = createWorkspace.body.id as string;

    const workspaces = await request(app)
      .get("/api/v1/workspace")
      .set("Cookie", cookie);
    const accountId = workspaces.body.workspaces[0].accountId as string;

    await dependencies.usageCaptureService.observe({
      operationKey: "multi-1",
      accountId,
      workspaceId,
      sourceArea: "chat",
      operationType: "chat_answer",
      model: "gpt-5-mini",
      eventStatus: "success",
      usageAvailable: true,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      occurredAt: new Date("2026-03-19T09:00:00.000Z"),
    });
    await dependencies.usageCaptureService.observe({
      operationKey: "multi-2",
      accountId,
      workspaceId: secondWorkspaceId,
      sourceArea: "retrieval",
      operationType: "embedding",
      model: "text-embedding-3-small",
      eventStatus: "success",
      usageAvailable: true,
      promptTokens: 20,
      completionTokens: 0,
      totalTokens: 20,
      occurredAt: new Date("2026-03-19T09:30:00.000Z"),
    });

    const response = await request(app)
      .get("/api/v1/account/usage")
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.daily[0]?.totals.totalTokens).toBe(35);
  });

  it("does not double-count duplicate operation keys", async () => {
    const { app, dependencies } = createTestApp();
    const { cookie, workspaceId } = await issueTestToken(app, "usage-dedupe@example.com");

    const workspaces = await request(app)
      .get("/api/v1/workspace")
      .set("Cookie", cookie);
    const accountId = workspaces.body.workspaces[0].accountId as string;

    await dependencies.usageCaptureService.observe({
      operationKey: "dedupe-1",
      accountId,
      workspaceId,
      sourceArea: "chat",
      operationType: "chat_answer",
      model: "gpt-5-mini",
      eventStatus: "success",
      usageAvailable: true,
      promptTokens: 9,
      completionTokens: 3,
      totalTokens: 12,
    });
    await dependencies.usageCaptureService.observe({
      operationKey: "dedupe-1",
      accountId,
      workspaceId,
      sourceArea: "chat",
      operationType: "chat_answer",
      model: "gpt-5-mini",
      eventStatus: "success",
      usageAvailable: true,
      promptTokens: 9,
      completionTokens: 3,
      totalTokens: 12,
    });

    const response = await request(app)
      .get("/api/v1/account/usage")
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.daily[0]?.totals.totalTokens).toBe(12);
  });

  it("includes async document-processing embedding usage in account totals", async () => {
    const { app } = createTestApp();
    const { cookie, token } = await issueTestToken(app, "usage-docs@example.com");

    const upload = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Reference",
        content: "A long enough document to generate chunk embeddings during asynchronous processing.",
      });

    expect(upload.status).toBe(202);

    const response = await request(app)
      .get("/api/v1/account/usage")
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.today.totalTokens).toBeGreaterThan(0);
    expect(response.body.daily[0]?.totals.totalTokens).toBeGreaterThan(0);
  });
});
