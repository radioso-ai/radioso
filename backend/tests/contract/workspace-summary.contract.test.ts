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
    });
  });
});
