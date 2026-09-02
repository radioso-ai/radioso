import { describe, expect, it } from "vitest";
import request from "supertest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const extractToken = (anonymousChatUrl: string): string => {
  const token = anonymousChatUrl.split("/").at(-1);
  if (!token) {
    throw new Error(`Could not extract token from ${anonymousChatUrl}`);
  }
  return token;
};

describe("access grants contract", () => {
  it("documents agent-bound chat credentials without workspace authorization fields", () => {
    const document = createOpenApiDocument();
    const paths = document.paths ?? {};
    const lifecyclePath = paths["/api/v1/agents/{agentId}/channel-credentials"];
    const rotatePath = paths["/api/v1/agents/{agentId}/channel-credentials/{credentialId}/rotate"];
    const revokePath = paths["/api/v1/agents/{agentId}/channel-credentials/{credentialId}/revoke"];
    const listParameters = lifecyclePath?.get?.parameters ?? [];
    const metadata = document.components?.schemas?.AgentChannelCredentialMetadata as {
      properties?: Record<string, unknown>;
    } | undefined;

    expect(paths["/api/v1/agents/{agentId}/chat"]?.post).toMatchObject({
      operationId: "createAgentChannelChatResponse",
      security: [{ agentChannelBearerAuth: [] }],
    });
    expect(lifecyclePath?.post?.operationId).toBe("issueAgentChannelCredential");
    for (const operation of [lifecyclePath?.post, rotatePath?.post, revokePath?.post]) {
      expect(operation?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          in: "header",
          name: "X-Radioso-CSRF",
          required: true,
          schema: expect.objectContaining({ type: "string", enum: ["1"] }),
        }),
      ]));
    }
    expect(lifecyclePath?.get?.operationId).toBe("listAgentChannelCredentials");
    expect(listParameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "query", name: "audience", required: false }),
    ]));
    expect(revokePath?.post?.operationId).toBe("revokeAgentChannelCredential");
    expect(revokePath?.delete).toBeUndefined();
    expect(metadata?.properties).not.toHaveProperty("role");
    expect(metadata?.properties).not.toHaveProperty("workspaceRole");
  });

  it("manages role-free per-agent channel credentials without exposing token material in lists", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "channel-credentials@example.com");
    const defaultAgent = await dependencies.agentService.resolve(session.workspaceId);

    await dependencies.accessGrantService.issueGrant({
      agentId: defaultAgent.id,
      workspaceId: session.workspaceId,
      principalKind: "public-launch",
      channel: "public-link",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    const issued = await request(app)
      .post(`/api/v1/agents/${defaultAgent.id}/channel-credentials`)
      .set(adminSessionHeaders(session))
      .set("X-Radioso-CSRF", "1")
      .send({ audience: "mcp", label: "Desktop client", expiresAt: "2027-06-28T10:00:00.000Z" });

    expect(issued.status).toBe(201);
    expect(issued.body.secret).toEqual(expect.any(String));
    expect(issued.body.credential).toEqual({
      id: expect.any(String),
      audience: "mcp",
      label: "Desktop client",
      prefix: expect.any(String),
      status: "active",
      createdAt: expect.any(String),
      expiresAt: "2027-06-28T10:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    });

    const grantId = issued.body.credential.id as string;
    const listed = await request(app)
      .get(`/api/v1/agents/${defaultAgent.id}/channel-credentials?audience=mcp`)
      .set(adminSessionHeaders(session));

    expect(listed.status).toBe(200);
    expect(listed.body.credentials).toEqual([
      {
        id: grantId,
        audience: "mcp",
        label: "Desktop client",
        prefix: issued.body.credential.prefix,
        status: "active",
        createdAt: issued.body.credential.createdAt,
        expiresAt: "2027-06-28T10:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    expect(listed.body.nextCursor).toBeNull();
    expect(JSON.stringify(listed.body)).not.toContain(issued.body.secret);

    const rotated = await request(app)
      .post(`/api/v1/agents/${defaultAgent.id}/channel-credentials/${grantId}/rotate`)
      .set(adminSessionHeaders(session))
      .set("X-Radioso-CSRF", "1")
      .send();

    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toEqual(expect.any(String));
    expect(rotated.body.secret).not.toBe(issued.body.secret);

    const revoked = await request(app)
      .post(`/api/v1/agents/${defaultAgent.id}/channel-credentials/${grantId}/revoke`)
      .set(adminSessionHeaders(session))
      .set("X-Radioso-CSRF", "1");

    expect(revoked.status).toBe(204);

    const afterRevoke = await request(app)
      .get(`/api/v1/agents/${defaultAgent.id}/channel-credentials?audience=mcp`)
      .set(adminSessionHeaders(session));
    expect(afterRevoke.status).toBe(200);
    expect(afterRevoke.body.credentials).toEqual([
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
