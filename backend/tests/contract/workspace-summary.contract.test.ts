import request from "supertest";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const inviteTeammate = async (
  app: ReturnType<typeof createTestApp>["app"],
  owner: Awaited<ReturnType<typeof issueTestSession>>,
  email: string,
) => {
  const invitation = await request(app)
    .post("/api/v1/account/invitations")
    .set("Cookie", owner.cookie)
    .send({ email });
  expect(invitation.status).toBe(201);
  const token = String(invitation.body.acceptanceUrl).split("/").at(-1);
  const accepted = await request(app)
    .post(`/api/v1/auth/invitations/${token}/accept`)
    .send({ email, password: "verysecurepassword" });
  expect(accepted.status).toBe(200);
  const cookie = accepted.headers["set-cookie"]?.[0];
  if (!cookie) throw new Error("Expected invitation acceptance to create a session");
  return { cookie, userId: accepted.body.userId as string };
};

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

  it("persists only setup-owned fields and supplies the first-run decision from the server", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "workspace-setup-state@example.com");

    const before = await request(app).get("/api/v1/workspace/setup-state").set(adminSessionHeaders(session));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ purpose: null, dismissed: false, shouldShowFirstRun: true });

    const updated = await request(app)
      .patch("/api/v1/workspace/setup-state")
      .set(adminSessionHeaders(session))
      .send({ purpose: "Answer product questions", dismissed: true, skippedSteps: ["credential"] });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      purpose: "Answer product questions",
      dismissed: true,
      skippedSteps: ["credential"],
      shouldShowFirstRun: false,
    });

    for (const body of [
      { dismissed: true, hasCredential: true },
      { dismissed: true, foo: 1 },
      {},
    ]) {
      const response = await request(app)
        .patch("/api/v1/workspace/setup-state")
        .set(adminSessionHeaders(session))
        .send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("publishes a closed PATCH request object", () => {
    const schema = createOpenApiDocument().components?.schemas?.UpdateWorkspaceSetupStateRequest;
    expect(schema).toMatchObject({ additionalProperties: false });
  });

  it("limits setup-state writes to owner/admin sessions and eligible admin machine credentials", async () => {
    const { app, dependencies } = createTestApp();
    const owner = await issueTestSession(app, "workspace-setup-owner@example.com");

    await request(app)
      .patch("/api/v1/workspace/setup-state")
      .set(adminSessionHeaders(owner))
      .send({ dismissed: true })
      .expect(200);

    const teammate = await inviteTeammate(app, owner, "workspace-setup-member@example.com");
    const memberHeaders = { Cookie: teammate.cookie, "X-Workspace-Id": owner.workspaceId };
    const memberRead = await request(app).get("/api/v1/workspace/setup-state").set(memberHeaders).expect(200);
    expect(memberRead.body).toMatchObject({ dismissed: true, shouldShowFirstRun: false });
    await request(app).patch("/api/v1/workspace/setup-state").set(memberHeaders).send({ dismissed: false }).expect(403);

    const memberPersonal = await dependencies.personalCredentialService.issue({
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      userId: teammate.userId,
      label: "Member setup contract",
      roleCeiling: "member",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app)
      .patch("/api/v1/workspace/setup-state")
      .set("Authorization", `Bearer ${memberPersonal.secret}`)
      .send({ dismissed: false })
      .expect(403);

    const membership = await dependencies.accountAccessService.requireActiveMembership(owner.accountId, teammate.userId);
    await dependencies.accountAccessService.updateMembershipRole({
      accountId: owner.accountId,
      actorUserId: owner.userId,
      membershipId: membership.id,
      role: "admin",
    });

    await request(app).patch("/api/v1/workspace/setup-state").set(memberHeaders).send({ dismissed: false }).expect(200);
    const adminPersonal = await dependencies.personalCredentialService.issue({
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      userId: teammate.userId,
      label: "Admin setup contract",
      roleCeiling: "admin",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const adminService = await dependencies.serviceAccountService.createWithCredential({
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      actorUserId: owner.userId,
      displayName: "Admin setup contract",
      role: "admin",
      expiresAt: new Date(Date.now() + 60_000),
    });
    for (const secret of [adminPersonal.secret, adminService.secret]) {
      await request(app)
        .patch("/api/v1/workspace/setup-state")
        .set("Authorization", `Bearer ${secret}`)
        .send({ dismissed: true })
        .expect(200);
    }

    const agent = await dependencies.agentService.resolve(owner.workspaceId);
    for (const channel of ["agent-api", "mcp-converse"] as const) {
      const credential = await dependencies.accessGrantService.issueGrant({
        agentId: agent.id,
        workspaceId: owner.workspaceId,
        principalKind: "agent-api",
        channel,
        originConstraint: { mode: "allow-all", origins: [] },
        expiresAt: new Date(Date.now() + 60_000),
      });
      await request(app)
        .patch("/api/v1/workspace/setup-state")
        .set("Authorization", `Bearer ${credential.token}`)
        .send({ dismissed: false })
        .expect(401);
    }
  });

  it("returns the project ErrorResponse JSON shape on crawl routes when WEBSITE_CRAWLER_ENABLED is false", async () => {
    const { app } = createTestApp({ envOverrides: { WEBSITE_CRAWLER_ENABLED: false } });
    const session = await issueTestSession(app, "workspace-crawl-disabled@example.com");

    const enqueueResponse = await request(app)
      .post("/api/v1/document/crawl")
      .set(adminSessionHeaders(session))
      .send({ url: "https://example.com" });

    expect(enqueueResponse.status).toBe(404);
    expect(enqueueResponse.headers["content-type"]).toMatch(/application\/json/);
    expect(enqueueResponse.body).toMatchObject({
      error: {
        code: "not_found",
        message: expect.stringMatching(/disabled/i),
      },
    });

    const listResponse = await request(app)
      .get("/api/v1/document/crawl/jobs")
      .set(adminSessionHeaders(session));

    expect(listResponse.status).toBe(404);
    expect(listResponse.body).toMatchObject({ error: { code: "not_found" } });

    const deleteResponse = await request(app)
      .delete("/api/v1/document/crawl/jobs/11111111-1111-4111-8111-111111111111")
      .set(adminSessionHeaders(session));

    expect(deleteResponse.status).toBe(404);
    expect(deleteResponse.body).toMatchObject({ error: { code: "not_found" } });
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
