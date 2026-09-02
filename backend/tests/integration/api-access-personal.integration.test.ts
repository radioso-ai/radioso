import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";

const expiresInDays = (days: number): string =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString();

describe("personal API access", () => {
  it("issues a one-time secret and keeps lifecycle routes session-only", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "personal-api-access@example.com");
    const headers = {
      Cookie: session.cookie,
      "X-Radioso-CSRF": "1",
      "X-Workspace-Id": session.workspaceId,
    };
    const base = `/api/v1/account/workspaces/${session.workspaceId}/api-access/personal-tokens`;
    const expiresAt = expiresInDays(60);

    const issued = await request(app)
      .post(base)
      .set(headers)
      .send({ label: "Local automation", roleCeiling: "admin", expiresAt })
      .expect(201);

    expect(issued.body.secret).toMatch(/^radioso_pat_v1_/);
    expect(issued.body.credential).toMatchObject({
      kind: "personal",
      label: "Local automation",
      roleCeiling: "admin",
      expiresAt,
      revision: 1,
    });
    expect(issued.body.credential).not.toHaveProperty("tokenHash");
    expect(issued.body.credential).not.toHaveProperty("secret");
    expect((dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata: Record<string, unknown> }> }).events)
      .toContainEqual(expect.objectContaining({
        eventType: "machine_access.personal_credential.issued",
        metadata: expect.objectContaining({
          actorUserId: session.userId,
          credentialId: issued.body.credential.id,
          principalId: session.userId,
          principalKind: "user",
          requestId: expect.any(String),
        }),
      }));

    const listed = await request(app).get(base).set(headers).expect(200);
    expect(listed.body).toMatchObject({ page: 1, limit: 50, total: 1 });
    expect(listed.body.items[0]).toMatchObject({ expiresAt, status: "active", expiryWarningDays: null });
    expect(listed.body.items[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(listed.body)).not.toContain(issued.body.secret);

    await request(app)
      .post(base)
      .set({ Cookie: session.cookie, "X-Workspace-Id": session.workspaceId })
      .send({ label: "Missing CSRF", roleCeiling: "member", expiresAt: expiresInDays(30) })
      .expect(403);

    await request(app)
      .patch(`${base}/${issued.body.credential.id}`)
      .set(headers)
      .set("Authorization", `Bearer ${issued.body.secret}`)
      .send({ label: "Must not run", revision: 1 })
      .expect(401);
  });

  it("rotates conditionally without returning the replacement secret again", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "personal-api-rotation@example.com");
    const headers = { Cookie: session.cookie, "X-Radioso-CSRF": "1", "X-Workspace-Id": session.workspaceId };
    const base = `/api/v1/account/workspaces/${session.workspaceId}/api-access/personal-tokens`;
    const issued = await request(app)
      .post(base)
      .set(headers)
      .send({ label: "Deploy", roleCeiling: "member", expiresAt: expiresInDays(30) })
      .expect(201);

    const rotated = await request(app)
      .post(`${base}/${issued.body.credential.id}/rotate`)
      .set(headers)
      .send({ revision: issued.body.credential.revision })
      .expect(201);

    expect(rotated.body.secret).toMatch(/^radioso_pat_v1_/);
    expect(rotated.body.secret).not.toBe(issued.body.secret);
    expect(rotated.body.credential.rotatedFromCredentialId).toBe(issued.body.credential.id);

    await request(app)
      .post(`${base}/${issued.body.credential.id}/rotate`)
      .set(headers)
      .send({ revision: issued.body.credential.revision })
      .expect(409);

    const listed = await request(app).get(base).set(headers).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(rotated.body.secret);
  });
});
