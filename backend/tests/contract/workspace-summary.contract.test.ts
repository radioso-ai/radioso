import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("workspace summary contract", () => {
  it("returns lightweight document and chat readiness counts for the authenticated workspace", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "workspace-summary@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({
        title: "Starter Guide",
        content: "Starter content for workspace summary.",
        metadata: {
          sampleDocument: true,
          sampleSlug: "starter-guide",
        },
      });

    await request(app)
      .post("/api/v1/assistant/chat")
      .set(adminSessionHeaders(session))
      .send({ message: "What is in the starter guide?", stream: false });

    const response = await request(app)
      .get("/api/v1/workspace/summary")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      documentCount: 1,
      readyDocumentCount: 1,
      pendingDocumentCount: 0,
      sampleDocumentCount: 1,
      sampleDocumentSlugs: ["starter-guide"],
      conversationCount: 1,
      hasDocuments: true,
      hasPendingDocuments: false,
      hasReadyDocuments: true,
      hasCompletedChat: true,
      sampleDocumentsImported: true,
      websiteCrawlerEnabled: true,
    });
  });

  it("reports websiteCrawlerEnabled=false when WEBSITE_CRAWLER_ENABLED is false", async () => {
    const { app } = createTestApp({ envOverrides: { WEBSITE_CRAWLER_ENABLED: false } });
    const session = await issueTestSession(app, "workspace-summary-crawler-disabled@example.com");

    const response = await request(app)
      .get("/api/v1/workspace/summary")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body.websiteCrawlerEnabled).toBe(false);
  });

  it("returns 404 for crawl routes when WEBSITE_CRAWLER_ENABLED is false", async () => {
    const { app } = createTestApp({ envOverrides: { WEBSITE_CRAWLER_ENABLED: false } });
    const session = await issueTestSession(app, "workspace-crawl-disabled@example.com");

    const enqueueResponse = await request(app)
      .post("/api/v1/document/crawl")
      .set(adminSessionHeaders(session))
      .send({ url: "https://example.com" });

    expect(enqueueResponse.status).toBe(404);

    const listResponse = await request(app)
      .get("/api/v1/document/crawl/jobs")
      .set(adminSessionHeaders(session));

    expect(listResponse.status).toBe(404);
  });

  it("counts queued and processing documents as pending but excludes failed documents", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "workspace-summary-failed@example.com");

    await repositories.documentRepository.create({
      workspaceId: session.workspaceId,
      title: "Failed Guide",
      sourceContent: "This document failed processing.",
      markdownContent: "This document failed processing.",
      status: "failed",
    });
    await repositories.documentRepository.create({
      workspaceId: session.workspaceId,
      title: "Queued Guide",
      sourceContent: "This document is queued.",
      markdownContent: "This document is queued.",
      status: "queued",
    });
    await repositories.documentRepository.create({
      workspaceId: session.workspaceId,
      title: "Processing Guide",
      sourceContent: "This document is processing.",
      markdownContent: "This document is processing.",
      status: "processing",
    });

    const response = await request(app)
      .get("/api/v1/workspace/summary")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      documentCount: 3,
      readyDocumentCount: 0,
      pendingDocumentCount: 2,
      hasDocuments: true,
      hasPendingDocuments: true,
      hasReadyDocuments: false,
    });
  });
});
