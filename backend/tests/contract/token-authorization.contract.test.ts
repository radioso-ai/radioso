import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const extractPublicChatToken = (anonymousChatUrl: string): string => {
  const token = anonymousChatUrl.split("/").at(-1);
  if (!token) {
    throw new Error(`Could not extract public chat token from ${anonymousChatUrl}`);
  }
  return token;
};

describe("token authorization contract", () => {
  it("rejects public chat launch credentials on the workspace API bearer path", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-launch-bearer@example.com");
    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: true });
    expect(settings.status).toBe(200);
    const publicLaunchCredential = extractPublicChatToken(settings.body.anonymousChatUrl);

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set("Authorization", `Bearer ${publicLaunchCredential}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: {
        code: "unauthorized",
      },
    });
  });

  it("rejects website embed launch credentials on the workspace API bearer path", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "embed-launch-bearer@example.com");
    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
      });
    expect(settings.status).toBe(200);
    const publicLaunchCredential = settings.body.websiteEmbedToken as string;

    const response = await request(app)
      .get("/api/v1/workspace/mcp/context")
      .set("Authorization", `Bearer ${publicLaunchCredential}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: {
        code: "unauthorized",
      },
    });
  });

  it("uses a valid session principal before bearer auth when both are present", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "mixed-auth-session@example.com");

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .set("Authorization", "Bearer not-a-valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      anonymousChatEnabled: false,
    });
  });

  it("falls back to a valid bearer principal when the session cookie is stale", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "mixed-auth-bearer@example.com");

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set("Cookie", "radioso_session=stale-session-token")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      anonymousChatEnabled: false,
    });
  });
});
