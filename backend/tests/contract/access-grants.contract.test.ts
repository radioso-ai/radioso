import { describe, expect, it } from "vitest";
import request from "supertest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const extractToken = (anonymousChatUrl: string): string => {
  const token = anonymousChatUrl.split("/").at(-1);
  if (!token) {
    throw new Error(`Could not extract token from ${anonymousChatUrl}`);
  }
  return token;
};

describe("access grants contract", () => {
  it("uses one grant lifecycle for public launch credentials", async () => {
    const { app, dependencies, repositories } = createTestApp();
    const session = await issueTestSession(app, "access-grants@example.com");

    const enabled = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
      });

    expect(enabled.status).toBe(200);
    const anonymousToken = extractToken(enabled.body.anonymousChatUrl);
    const embedToken = enabled.body.websiteEmbedToken as string;

    const initialEmbedGrant = await dependencies.accessGrantService.resolvePublicLaunchGrant(embedToken);
    expect(initialEmbedGrant?.principalKind).toBe("public-launch");
    expect(initialEmbedGrant?.role).toBe("public");
    expect(initialEmbedGrant).not.toHaveProperty("scopes");
    expect(initialEmbedGrant?.lastUsedAt).toBeNull();

    const firstSession = await request(app)
      .post(`/api/v1/public/chat/${embedToken}/sessions`)
      .set("Origin", "https://example.com")
      .send({ channel: "website_embed" });
    expect(firstSession.status).toBe(200);

    const touchedEmbedGrant = await dependencies.accessGrantService.resolvePublicLaunchGrant(embedToken);
    expect(touchedEmbedGrant?.lastUsedAt).toBeInstanceOf(Date);

    const defaultAgent = await dependencies.agentService.resolve(session.workspaceId);
    const agentLifecycle = await request(app)
      .get(`/api/v1/agents/${defaultAgent.id}/channels/lifecycle`)
      .set(adminSessionHeaders(session));
    expect(agentLifecycle.status).toBe(200);
    expect(agentLifecycle.body.websiteEmbed).toEqual({
      lastUsedAt: touchedEmbedGrant?.lastUsedAt?.toISOString(),
      status: "active",
    });
    expect(agentLifecycle.body.anonymousChat).toEqual({
      lastUsedAt: null,
      status: "active",
    });

    const afterTouchSettings = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session));
    expect(afterTouchSettings.status).toBe(200);
    expect(afterTouchSettings.body.websiteEmbedLastUsedAt).toBe(touchedEmbedGrant?.lastUsedAt?.toISOString());
    expect(afterTouchSettings.body.websiteEmbedStatus).toBe("active");

    const rotated = await request(app)
      .post("/api/v1/settings/general/website-embed-token/rotate")
      .set(adminSessionHeaders(session))
      .send();
    expect(rotated.status).toBe(200);
    const rotatedEmbedToken = rotated.body.websiteEmbedToken as string;
    expect(rotatedEmbedToken).not.toBe(embedToken);

    const oldRejected = await request(app)
      .post(`/api/v1/public/chat/${embedToken}/sessions`)
      .set("Origin", "https://example.com")
      .send({ channel: "website_embed" });
    expect(oldRejected.status).toBe(404);

    const newAccepted = await request(app)
      .post(`/api/v1/public/chat/${rotatedEmbedToken}/sessions`)
      .set("Origin", "https://example.com")
      .send({ channel: "website_embed" });
    expect(newAccepted.status).toBe(200);

    const grant = await dependencies.accessGrantService.resolvePublicLaunchGrant(rotatedEmbedToken);
    expect(grant).not.toBeNull();
    await dependencies.accessGrantService.revokeGrant({
      grantId: grant!.id,
      accountId: session.accountId,
      reason: "contract_test",
    });

    const revokedRejected = await request(app)
      .post(`/api/v1/public/chat/${rotatedEmbedToken}/sessions`)
      .set("Origin", "https://example.com")
      .send({ channel: "website_embed" });
    expect(revokedRejected.status).toBe(404);

    const afterRevokeSettings = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session));
    expect(afterRevokeSettings.status).toBe(200);
    expect(afterRevokeSettings.body.websiteEmbedToken).toBe(rotatedEmbedToken);

    const anonymousGrant = await dependencies.accessGrantService.resolvePublicLaunchGrant(anonymousToken);
    expect(anonymousGrant?.principalKind).toBe("public-launch");
    expect(anonymousGrant?.role).toBe("public");
    expect(anonymousGrant).not.toHaveProperty("scopes");
    expect(repositories.accessGrantRepository.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: anonymousGrant?.id }),
        expect.objectContaining({ id: grant?.id, revokedAt: expect.any(Date) }),
      ]),
    );
  });

  it("revokes a public launch grant through settings without rotating the current token", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "access-grants-settings-revoke@example.com");

    const enabled = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
      });

    expect(enabled.status).toBe(200);
    expect(enabled.body.anonymousChatStatus).toBe("active");
    const anonymousUrl = enabled.body.anonymousChatUrl as string;
    const anonymousToken = extractToken(anonymousUrl);
    const grant = await dependencies.accessGrantService.resolvePublicLaunchGrant(anonymousToken);
    expect(grant).not.toBeNull();

    const revoked = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        revokeAnonymousChatToken: true,
      });

    expect(revoked.status).toBe(200);
    expect(revoked.body.anonymousChatUrl).toBe(anonymousUrl);
    expect(revoked.body.anonymousChatStatus).toBe("revoked");

    const laterSave = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        assistantName: "Support",
      });

    expect(laterSave.status).toBe(200);
    expect(laterSave.body.anonymousChatUrl).toBe(anonymousUrl);
    expect(laterSave.body.anonymousChatStatus).toBe("revoked");

    const currentGrant = await dependencies.accessGrantService.resolvePublicLaunchGrant(anonymousToken);
    expect(currentGrant?.id).toBe(grant?.id);
    expect(currentGrant?.revokedAt).toBeInstanceOf(Date);
  });
});
