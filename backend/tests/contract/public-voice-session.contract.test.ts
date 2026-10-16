import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/app/config/env.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const SITE = "https://example.com";
const VENDOR_KEY = "xi-workspace-secret-0123456789";
const SIGNED_URL = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const boundVoice = { enabled: true, bridgeLines: {}, fallbackLine: {}, runtime: { vendor: "elevenlabs", agentId: "agent_42" } };

type VendorFetch = typeof globalThis.fetch;

const vendorAnswering = (status: number, body: unknown) =>
  vi.fn<VendorFetch>(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/**
 * A workspace whose website embed admits the test site, with a visitor session on it. The agent's
 * voice block and the workspace's vendor key are what each case varies.
 */
const embedWithVisitor = async (options: {
  email: string;
  voice?: typeof boundVoice | { enabled: boolean; bridgeLines: object; fallbackLine: object; runtime: null };
  vendorKey?: string | null;
  vendorFetch?: VendorFetch;
  envOverrides?: Partial<Env>;
}) => {
  const { app } = createTestApp({ voiceVendorFetch: options.vendorFetch, envOverrides: options.envOverrides });
  const operator = await issueTestSession(app, options.email);
  const dashboard = adminSessionHeaders(operator);
  const settings = await request(app)
    .put("/api/v1/settings/general")
    .set(dashboard)
    .send({ websiteEmbedEnabled: true, websiteEmbedAllowedOrigins: [SITE] })
    .expect(200);
  const launchToken = settings.body.websiteEmbedToken as string;
  const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
  const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
  await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ voice: options.voice ?? boundVoice }).expect(200);
  const vendorKey = options.vendorKey === undefined ? VENDOR_KEY : options.vendorKey;
  if (vendorKey) {
    await request(app).put("/api/v1/settings/credentials/elevenlabs").set(dashboard).send({ apiKey: vendorKey }).expect(204);
  }
  const visitor = await request(app)
    .post(`/api/v1/public/chat/${launchToken}/sessions`)
    .set("Origin", SITE)
    .send({ channel: "website_embed" })
    .expect(200);
  const startVoiceSession = (body: object = {}, headers: Record<string, string> = {}) =>
    request(app)
      .post(`/api/v1/public/chat/${launchToken}/voice/sessions`)
      .set({ Origin: SITE, "x-radioso-public-session": visitor.body.publicSessionToken as string, ...headers })
      .send(body);
  return { startVoiceSession };
};

describe("public voice session start contract", () => {
  it("starts a session on the agent's ElevenLabs agent with the workspace's key and hands the page what it needs, never the key", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { startVoiceSession } = await embedWithVisitor({ email: "voice-start-happy@example.com", vendorFetch });

    const response = await startVoiceSession({ locale: "it" }).expect(200);

    expect(response.body).toEqual({
      vendor: "elevenlabs",
      signedUrl: SIGNED_URL,
      sessionKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      locale: "it",
      expiresAt: expect.any(String),
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toContain(VENDOR_KEY);
    expect(vendorFetch).toHaveBeenCalledTimes(1);
    const [url, init] = vendorFetch.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_42");
    expect(init?.headers).toEqual({ "xi-api-key": VENDOR_KEY });
  });

  it("mints a new session key for every start", async () => {
    const { startVoiceSession } = await embedWithVisitor({
      email: "voice-start-fresh-key@example.com",
      vendorFetch: vendorAnswering(200, { signed_url: SIGNED_URL }),
    });

    const first = await startVoiceSession().expect(200);
    const second = await startVoiceSession().expect(200);

    expect(first.body.sessionKey).not.toBe(second.body.sessionKey);
  });

  it.each([
    ["voice is off for the agent", { ...boundVoice, enabled: false }],
    ["the agent is bound to no vendor agent", { ...boundVoice, runtime: null }],
  ])("answers 404 and asks the vendor nothing when %s", async (_case, voice) => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { startVoiceSession } = await embedWithVisitor({ email: `voice-start-off-${voice.enabled}@example.com`, voice, vendorFetch });

    const response = await startVoiceSession().expect(404);

    expect(response.body.error.code).toBe("not_found");
    expect(vendorFetch).not.toHaveBeenCalled();
  });

  it("answers 409 with a stable code when the workspace holds no key for the agent's vendor", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { startVoiceSession } = await embedWithVisitor({ email: "voice-start-no-key@example.com", vendorKey: null, vendorFetch });

    const response = await startVoiceSession().expect(409);

    expect(response.body.error).toMatchObject({ code: "voice_vendor_credential_missing", details: { vendor: "elevenlabs" } });
    expect(vendorFetch).not.toHaveBeenCalled();
  });

  it("answers 502 when the vendor refuses the start, without passing on what the vendor said", async () => {
    const { startVoiceSession } = await embedWithVisitor({
      email: "voice-start-vendor-down@example.com",
      vendorFetch: vendorAnswering(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }),
    });

    const response = await startVoiceSession().expect(502);

    expect(response.body.error).toMatchObject({ code: "voice_vendor_unavailable", details: { vendor: "elevenlabs" } });
    expect(JSON.stringify(response.body)).not.toContain("invalid_api_key");
  });

  it("starts nothing without the visitor's public session, or from a site the embed does not admit", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { startVoiceSession } = await embedWithVisitor({ email: "voice-start-no-session@example.com", vendorFetch });

    await startVoiceSession({}, { "x-radioso-public-session": "" }).expect(404);
    await startVoiceSession({}, { Origin: "https://not-approved.example.com" }).expect(404);
    expect(vendorFetch).not.toHaveBeenCalled();
  });

  it("refuses a locale that is not a language tag", async () => {
    const { startVoiceSession } = await embedWithVisitor({
      email: "voice-start-bad-locale@example.com",
      vendorFetch: vendorAnswering(200, { signed_url: SIGNED_URL }),
    });

    await startVoiceSession({ locale: "{{system__locale}}" }).expect(400);
  });

  it("limits session starts per visitor on their own budget", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { startVoiceSession } = await embedWithVisitor({
      email: "voice-start-rate-limit@example.com",
      vendorFetch,
      envOverrides: { PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 2 },
    });

    await startVoiceSession().expect(200);
    await startVoiceSession().expect(200);
    const limited = await startVoiceSession().expect(429);

    expect(limited.body.error.code).toBe("rate_limit_exceeded");
    expect(vendorFetch).toHaveBeenCalledTimes(2);
  });
});
