import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("public launch bearer rejection contract", () => {
  it("rejects a public-launch grant token on bearer REST endpoints", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-launch-rest-bearer@example.com");

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://host.example"],
      })
      .expect(200);
    const publicLaunchToken = settings.body.websiteEmbedToken as string;

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set("Authorization", `Bearer ${publicLaunchToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("denies wrong-agent and wrong-workspace public sessions without enumeration", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-launch-enumeration@example.com");
    const authorization = adminSessionHeaders(session);

    const defaultAgent = await request(app)
      .get("/api/v1/agents")
      .set(authorization)
      .expect(200);
    const defaultAgentId = defaultAgent.body.agents[0].id as string;
    await request(app)
      .put(`/api/v1/agents/${defaultAgentId}`)
      .set(authorization)
      .send({
        surfaceSettings: {
          websiteEmbed: {
            enabled: true,
            allowedOrigins: ["https://host.example"],
          },
        },
      })
      .expect(200);
    const defaultTokenResponse = await request(app)
      .post(`/api/v1/agents/${defaultAgentId}/website-embed-token/rotate`)
      .set(authorization)
      .expect(200);
    const defaultToken = defaultTokenResponse.body.surfaceSettings.websiteEmbed.token as string;
    const defaultSession = await request(app)
      .post(`/api/v1/public/chat/${defaultToken}/sessions`)
      .set("Origin", "https://host.example")
      .send({ channel: "website_embed" })
      .expect(200);

    const sideAgent = await request(app)
      .post("/api/v1/agents")
      .set(authorization)
      .send({ name: "Side agent" })
      .expect(201);
    await request(app)
      .put(`/api/v1/agents/${sideAgent.body.id}`)
      .set(authorization)
      .send({
        surfaceSettings: {
          websiteEmbed: {
            enabled: true,
            allowedOrigins: ["https://host.example"],
          },
        },
      })
      .expect(200);
    const sideTokenResponse = await request(app)
      .post(`/api/v1/agents/${sideAgent.body.id}/website-embed-token/rotate`)
      .set(authorization)
      .expect(200);
    const sideToken = sideTokenResponse.body.surfaceSettings.websiteEmbed.token as string;

    const wrongAgent = await request(app)
      .post(`/api/v1/public/chat/${sideToken}`)
      .set("x-radioso-public-session", defaultSession.body.publicSessionToken)
      .send({ message: "hello", stream: false })
      .expect(404);
    expect(wrongAgent.body).toMatchObject({
      error: { code: "not_found" },
    });

    const otherSession = await issueTestSession(app, "other-workspace-public-launch@example.com");
    const otherSettings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(otherSession))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://host.example"],
      })
      .expect(200);
    const otherToken = otherSettings.body.websiteEmbedToken as string;

    const wrongWorkspace = await request(app)
      .post(`/api/v1/public/chat/${otherToken}`)
      .set("x-radioso-public-session", defaultSession.body.publicSessionToken)
      .send({ message: "hello", stream: false })
      .expect(404);
    expect(wrongWorkspace.body).toMatchObject({
      error: { code: "not_found" },
    });
  });
});
