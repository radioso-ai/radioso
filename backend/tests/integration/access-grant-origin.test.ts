import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const enableWebsiteEmbed = async (
  app: ReturnType<typeof createTestApp>["app"],
  session: Awaited<ReturnType<typeof issueTestSession>>,
  input: {
    allowedOrigins?: string[];
  },
) => {
  const response = await request(app)
    .put("/api/v1/settings/general")
    .set(adminSessionHeaders(session))
    .send({
      websiteEmbedEnabled: true,
      websiteEmbedAllowedOrigins: input.allowedOrigins,
    });
  expect(response.status).toBe(200);
  return response.body.websiteEmbedToken as string;
};

describe("access grant origin constraints", () => {
  it("admits listed origins and rejects unlisted origins", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "grant-origin-list@example.com");
    const token = await enableWebsiteEmbed(app, session, {
      allowedOrigins: ["https://a.example"],
    });

    await request(app)
      .post(`/api/v1/public/chat/${token}/sessions`)
      .set("Origin", "https://a.example")
      .send({ channel: "website_embed" })
      .expect(200);

    await request(app)
      .post(`/api/v1/public/chat/${token}/sessions`)
      .set("Origin", "https://b.example")
      .send({ channel: "website_embed" })
      .expect(403);
  });

  it('admits any origin when "*" is saved as an allowed origin', async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "grant-origin-allow-all@example.com");
    const token = await enableWebsiteEmbed(app, session, {
      allowedOrigins: ["*"],
    });

    await request(app)
      .post(`/api/v1/public/chat/${token}/sessions`)
      .set("Origin", "https://first.example")
      .send({ channel: "website_embed" })
      .expect(200);

    await request(app)
      .post(`/api/v1/public/chat/${token}/sessions`)
      .set("Origin", "https://second.example")
      .send({ channel: "website_embed" })
      .expect(200);
  });

  it("rejects saving an enabled website embed with an empty origin list", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "grant-origin-empty-list@example.com");

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: [],
      });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('At least one allowed origin is required when website embed is enabled (use "*" to allow all)');
  });

  it("uses the signed bound session origin when the embedded widget omits Origin", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "grant-origin-bound-session@example.com");
    const token = await enableWebsiteEmbed(app, session, {
      allowedOrigins: ["https://host.example"],
    });

    const publicSession = await request(app)
      .post(`/api/v1/public/chat/${token}/sessions`)
      .set("Origin", "https://host.example")
      .send({ channel: "website_embed" })
      .expect(200);

    await request(app)
      .post(`/api/v1/public/chat/${token}`)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({ message: "hello", stream: false })
      .expect(200);
  });
});
