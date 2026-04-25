import { describe, it, expect } from "vitest";
import request from "supertest";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("general settings contract", () => {
  it("GET /api/v1/settings/general returns default settings", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      anonymousChatEnabled: false,
      anonymousChatUrl: null,
      anonymousRateLimit: 10,
      assistantName: "",
      assistantRole: "",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
      assistantBootstrapActive: false,
      websiteEmbedEnabled: false,
      websiteEmbedToken: null,
      websiteEmbedScriptUrl: "http://localhost:3000/radioso-embed.js",
      websiteEmbedSnippet: null,
      websiteEmbedAllowedOrigins: [],
    });
    expect(response.body.websiteEmbedLauncherLabel).toEqual(expect.any(String));
    expect(response.body.websiteEmbedLauncherIcon).toEqual(expect.any(String));
    expect(response.body.websiteEmbedLauncherPosition).toEqual(expect.any(String));
  });

  it("PUT /api/v1/settings/general enables anonymous chat and generates URL", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: true });

    expect(response.status).toBe(200);
    expect(response.body.anonymousChatEnabled).toBe(true);
    expect(response.body.anonymousChatUrl).toBeDefined();
    expect(response.body.anonymousChatUrl).toContain("/chat/");
    expect(response.body.anonymousRateLimit).toBe(10);
    expect(response.body.assistantBootstrapActive).toBe(false);
  });

  it("PUT /api/v1/settings/general updates rate limit", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: true, anonymousRateLimit: 20 });

    expect(response.status).toBe(200);
    expect(response.body.anonymousRateLimit).toBe(20);
  });

  it("round-trips website embed settings and generated snippet", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com/help", "https://docs.example.com"],
        websiteEmbedLauncherLabel: "Talk to Marta",
        websiteEmbedLauncherIcon: "sparkles",
        websiteEmbedLauncherPosition: "bottom-left",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      websiteEmbedEnabled: true,
      websiteEmbedAllowedOrigins: ["https://example.com", "https://docs.example.com"],
      websiteEmbedLauncherLabel: "Talk to Marta",
      websiteEmbedLauncherIcon: "sparkles",
      websiteEmbedLauncherPosition: "bottom-left",
      websiteEmbedScriptUrl: "http://localhost:3000/radioso-embed.js",
    });
    expect(response.body.websiteEmbedToken).toEqual(expect.any(String));
    expect(response.body.websiteEmbedSnippet).toContain('data-radioso-token="');
    expect(response.body.websiteEmbedSnippet).toContain(response.body.websiteEmbedToken);
  });

  it("rejects enabling website embed without approved origins", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: [],
      });

    expect(response.status).toBe(400);
  });

  it("toggling off preserves token but returns null URL", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    // Enable
    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: true });

    // Disable
    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: false });

    expect(response.status).toBe(200);
    expect(response.body.anonymousChatEnabled).toBe(false);
    expect(response.body.anonymousChatUrl).toBeNull();

    // Re-enable — should reuse same token
    const reEnabled = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: true });

    expect(reEnabled.body.anonymousChatEnabled).toBe(true);
    expect(reEnabled.body.anonymousChatUrl).toBeDefined();
  });

  it("rotates anonymous chat and website embed tokens on demand", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const initial = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
      });

    expect(initial.status).toBe(200);

    const initialAnonymousUrl = initial.body.anonymousChatUrl as string;
    const initialEmbedToken = initial.body.websiteEmbedToken as string;

    const rotated = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        rotateAnonymousChatToken: true,
        rotateWebsiteEmbedToken: true,
      });

    expect(rotated.status).toBe(200);
    expect(rotated.body.anonymousChatEnabled).toBe(true);
    expect(rotated.body.websiteEmbedEnabled).toBe(true);
    expect(rotated.body.anonymousChatUrl).toEqual(expect.any(String));
    expect(rotated.body.websiteEmbedToken).toEqual(expect.any(String));
    expect(rotated.body.anonymousChatUrl).not.toBe(initialAnonymousUrl);
    expect(rotated.body.websiteEmbedToken).not.toBe(initialEmbedToken);
    expect(rotated.body.websiteEmbedSnippet).toContain(rotated.body.websiteEmbedToken);
  });

  it("rejects unauthenticated access", async () => {
    const { app } = createTestApp();

    const response = await request(app).get("/api/v1/settings/general");

    expect(response.status).toBe(401);
  });

  it("rejects invalid rate limit", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({ anonymousChatEnabled: true, anonymousRateLimit: 100 });

    expect(response.status).toBe(400);
  });

  it("round-trips assistant bootstrap settings in general settings", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        assistantName: "Marta",
        assistantRole: "Museum guide",
        greetingInstruction: "Warm and concise",
        assistantDefaultLocale: "it-IT",
        proactiveGreetingEnabled: true,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      assistantName: "Marta",
      assistantRole: "Museum guide",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: "it-IT",
      proactiveGreetingEnabled: true,
      assistantBootstrapActive: true,
    });

    const fetched = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session));

    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      assistantName: "Marta",
      assistantRole: "Museum guide",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: "it-IT",
      proactiveGreetingEnabled: true,
      assistantBootstrapActive: true,
    });
  });

  it("marks bootstrap inactive when proactive greeting is enabled but identity is blank", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        assistantName: "   ",
        assistantRole: "",
        greetingInstruction: "",
        proactiveGreetingEnabled: true,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      assistantName: "",
      assistantRole: "",
      greetingInstruction: "",
      proactiveGreetingEnabled: true,
      assistantBootstrapActive: false,
    });
  }, 10000);

  it("does not partially persist general settings when validation fails", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app);

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
        anonymousRateLimit: 20,
        assistantDefaultLocale: "not a locale",
      });

    expect(response.status).toBe(400);

    const fetched = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session));

    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      anonymousChatEnabled: false,
      anonymousRateLimit: 10,
      assistantDefaultLocale: null,
    });
  });
});
