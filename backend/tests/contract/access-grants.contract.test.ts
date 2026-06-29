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
  it("manages per-agent MCP converse credentials without exposing token material in lists", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "mcp-converse-grants@example.com");
    const defaultAgent = await dependencies.agentService.resolve(session.workspaceId);

    await dependencies.accessGrantService.issueGrant({
      agentId: defaultAgent.id,
      workspaceId: session.workspaceId,
      principalKind: "public-launch",
      channel: "public-link",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    const issued = await request(app)
      .post(`/api/v1/agents/${defaultAgent.id}/mcp-converse-grants`)
      .set(adminSessionHeaders(session))
      .send({ label: "Desktop client" });

    expect(issued.status).toBe(201);
    expect(issued.body.token).toEqual(expect.any(String));
    expect(issued.body.grant).toEqual({
      id: expect.any(String),
      label: "Desktop client",
      tokenPrefix: expect.any(String),
      createdAt: expect.any(String),
    });

    const grantId = issued.body.grant.id as string;
    const listed = await request(app)
      .get(`/api/v1/agents/${defaultAgent.id}/mcp-converse-grants`)
      .set(adminSessionHeaders(session));

    expect(listed.status).toBe(200);
    expect(listed.body.grants).toEqual([
      {
        id: grantId,
        label: "Desktop client",
        tokenPrefix: issued.body.grant.tokenPrefix,
        enabled: true,
        createdAt: issued.body.grant.createdAt,
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(issued.body.token);

    const rotated = await request(app)
      .post(`/api/v1/agents/${defaultAgent.id}/mcp-converse-grants/${grantId}/rotate`)
      .set(adminSessionHeaders(session))
      .send();

    expect(rotated.status).toBe(200);
    expect(rotated.body.token).toEqual(expect.any(String));
    expect(rotated.body.token).not.toBe(issued.body.token);

    const revoked = await request(app)
      .delete(`/api/v1/agents/${defaultAgent.id}/mcp-converse-grants/${grantId}`)
      .set(adminSessionHeaders(session));

    expect(revoked.status).toBe(204);

    const afterRevoke = await request(app)
      .get(`/api/v1/agents/${defaultAgent.id}/mcp-converse-grants`)
      .set(adminSessionHeaders(session));
    expect(afterRevoke.status).toBe(200);
    expect(afterRevoke.body.grants).toEqual([
      expect.objectContaining({
        id: grantId,
        revokedAt: expect.any(String),
      }),
    ]);
  });

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
    });
    expect(agentLifecycle.body.anonymousChat).toEqual({
      lastUsedAt: null,
    });

    const afterTouchSettings = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session));
    expect(afterTouchSettings.status).toBe(200);
    expect(afterTouchSettings.body.websiteEmbedLastUsedAt).toBe(touchedEmbedGrant?.lastUsedAt?.toISOString());

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
});
