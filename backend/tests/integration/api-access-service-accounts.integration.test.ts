import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";

describe("service-account API access", () => {
  it("creates a stable service principal with a one-time credential and live disable", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "service-api-access@example.com");
    const headers = { Cookie: session.cookie, "X-Radioso-CSRF": "1", "X-Workspace-Id": session.workspaceId };
    const base = `/api/v1/account/workspaces/${session.workspaceId}/api-access/service-accounts`;
    const credentialExpiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000).toISOString();

    const created = await request(app)
      .post(base)
      .set(headers)
      .send({
        displayName: "CI deployment",
        role: "admin",
        credentialExpiresAt,
      })
      .expect(201);

    expect(created.body.secret).toMatch(/^radioso_svc_v1_/);
    expect(created.body.serviceAccount).toMatchObject({
      displayName: "CI deployment",
      role: "admin",
      status: "enabled",
      activeCredentialCount: 1,
      revision: 1,
    });
    expect(created.body.credential.serviceAccountId).toBe(created.body.serviceAccount.id);
    expect(created.body.credential).toMatchObject({
      label: "Primary",
      expiresAt: credentialExpiresAt,
      status: "active",
      expiryWarningDays: null,
    });

    await request(app)
      .get("/api/v1/settings/general")
      .set("Authorization", `Bearer ${created.body.secret}`)
      .expect(401);

    await request(app)
      .post("/api/v1/document/search")
      .set("Authorization", `Bearer ${created.body.secret}`)
      .send({ query: "attribution check" })
      .expect(200);
    expect((dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata: Record<string, unknown> }> }).events)
      .toContainEqual(expect.objectContaining({
        eventType: "document.search",
        metadata: expect.objectContaining({
          credentialId: created.body.credential.id,
          principalId: created.body.serviceAccount.id,
          principalKind: "service",
          requestId: expect.any(String),
          role: "admin",
        }),
      }));

    const disabled = await request(app)
      .post(`${base}/${created.body.serviceAccount.id}/disable`)
      .set(headers)
      .send({ revision: created.body.serviceAccount.revision })
      .expect(200);
    expect(disabled.body).toMatchObject({ status: "disabled", revision: 2 });
    expect((dependencies.auditService as unknown as { events: Array<{ eventType: string }> }).events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "machine_access.service_account.created" }),
        expect.objectContaining({ eventType: "machine_access.service_account.disabled" }),
      ]));

    await request(app)
      .get("/api/v1/settings/general")
      .set("Authorization", `Bearer ${created.body.secret}`)
      .expect(401);

    const credentials = await request(app)
      .get(`${base}/${created.body.serviceAccount.id}/credentials`)
      .set(headers)
      .expect(200);
    expect(credentials.body).toMatchObject({ page: 1, limit: 50, total: 1 });
    expect(credentials.body.items[0]).toMatchObject({ label: "Primary", expiresAt: credentialExpiresAt, status: "suspended", expiryWarningDays: null });
    expect(JSON.stringify(credentials.body)).not.toContain(created.body.secret);
  });

  it("archives atomically and prevents re-enable", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "service-api-archive@example.com");
    const headers = { Cookie: session.cookie, "X-Radioso-CSRF": "1", "X-Workspace-Id": session.workspaceId };
    const base = `/api/v1/account/workspaces/${session.workspaceId}/api-access/service-accounts`;
    const created = await request(app)
      .post(base)
      .set(headers)
      .send({
        displayName: "Archived integration",
        role: "member",
        credentialExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      })
      .expect(201);

    const archived = await request(app)
      .post(`${base}/${created.body.serviceAccount.id}/archive`)
      .set(headers)
      .send({ revision: 1 })
      .expect(200);
    expect(archived.body).toMatchObject({ status: "archived", activeCredentialCount: 0, revision: 2 });
    expect((dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata: Record<string, unknown> }> }).events)
      .toContainEqual(expect.objectContaining({
        eventType: "machine_access.service_credential.invalidated",
        metadata: expect.objectContaining({
          credentialId: created.body.credential.id,
          principalId: created.body.serviceAccount.id,
          reason: "service_account_archived",
          requestId: expect.any(String),
        }),
      }));

    await request(app)
      .post(`${base}/${created.body.serviceAccount.id}/enable`)
      .set(headers)
      .send({ revision: 2 })
      .expect(409);
  });
});
