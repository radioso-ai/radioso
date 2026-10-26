import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/app/config/env.js";
import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { VOICE_CALL_READINESS_GAPS } from "../../src/modules/voiceChannel/public.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const SITE = "https://example.com";
const VENDOR_KEY = "xi-workspace-secret-0123456789";
const SIGNED_URL = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const boundVoice = { enabled: true, bridgeLines: {}, fallbackLine: {}, runtime: { vendor: "elevenlabs", agentId: "agent_42", region: "us" } };

type VendorFetch = typeof globalThis.fetch;

const vendorAnswering = (status: number, body: unknown) =>
  vi.fn<VendorFetch>(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/**
 * A workspace whose website embed admits the test site, with the agent's voice bound to an
 * ElevenLabs agent and the workspace's ElevenLabs key stored. Each case varies one of those.
 */
const embedWorkspace = async (options: {
  voice?: object;
  /** The operator's switch on the website embed: whether it offers calls. */
  voiceCallsOffered?: boolean;
  vendorKey?: string | null;
  vendorFetch?: VendorFetch;
  envOverrides?: Partial<Env>;
  embedConfigCacheInvalidator?: { invalidateForToken(token: string): Promise<void> };
} = {}) => {
  const created = createTestApp({
    voiceVendorFetch: options.vendorFetch,
    envOverrides: options.envOverrides,
    embedConfigCacheInvalidator: options.embedConfigCacheInvalidator,
  });
  const { app } = created;
  const operator = await issueTestSession(app, `voice-start-${randomUUID()}@example.com`);
  const dashboard = adminSessionHeaders(operator);
  const settings = await request(app)
    .put("/api/v1/settings/general")
    .set(dashboard)
    .send({ websiteEmbedEnabled: true, websiteEmbedAllowedOrigins: [SITE], anonymousChatEnabled: true })
    .expect(200);
  const launchToken = settings.body.websiteEmbedToken as string;
  const anonymousChatToken = new URL(settings.body.anonymousChatUrl as string).pathname.split("/").at(-1)!;
  const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
  const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
  await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({
    voice: options.voice ?? boundVoice,
    ...(options.voiceCallsOffered === undefined ? {} : { surfaceSettings: { websiteEmbed: { voiceCallsOffered: options.voiceCallsOffered } } }),
  }).expect(200);
  const vendorKey = options.vendorKey === undefined ? VENDOR_KEY : options.vendorKey;
  if (vendorKey) {
    await request(app).put("/api/v1/settings/credentials/elevenlabs").set(dashboard).send({ apiKey: vendorKey }).expect(204);
  }
  /** A website embed visitor: its public session, and a way to start voice sessions with it. */
  const visitor = async (body: object = {}) => {
    const session = await request(app)
      .post(`/api/v1/public/chat/${launchToken}/sessions`)
      .set("Origin", SITE)
      .send({ channel: "website_embed", ...body })
      .expect(200);
    const publicSessionToken = session.body.publicSessionToken as string;
    const startVoiceSession = (startBody: object = {}, headers: Record<string, string> = {}) =>
      request(app)
        .post(`/api/v1/public/chat/${launchToken}/voice/sessions`)
        .set({ Origin: SITE, "x-radioso-public-session": publicSessionToken, ...headers })
        .send(startBody);
    return { publicSessionToken, startVoiceSession };
  };
  /** What the website embed's launcher reads before it shows anything. */
  const embedConfig = () => request(app).get(`/api/v1/public/chat/${launchToken}/embed-config`).set("Origin", SITE).expect(200);
  return { ...created, operator, dashboard, agentId, launchToken, anonymousChatToken, visitor, embedConfig };
};

const startOutcomes = (metrics: string): string[] =>
  metrics.split("\n").filter((line) => line.startsWith("radioso_voice_session_start_total{"));

describe("public voice session start contract", () => {
  it("starts a session on the agent's ElevenLabs agent with the workspace's key and hands the page what it needs, never the key", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { visitor } = await embedWorkspace({ vendorFetch });
    const { startVoiceSession } = await visitor();

    const response = await startVoiceSession({ locale: "it" }).expect(200);

    expect(response.body).toEqual({
      vendor: "elevenlabs",
      signedUrl: SIGNED_URL,
      sessionKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      locale: "it",
      expiresAt: expect.any(String),
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBe(SITE);
    expect(JSON.stringify(response.body)).not.toContain(VENDOR_KEY);
    const [url, init] = vendorFetch.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_42");
    expect(init?.headers).toEqual({ "xi-api-key": VENDOR_KEY });
  });

  it("starts an EU-residency account's session on the EU host", async () => {
    const euSignedUrl = "wss://api.eu.residency.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
    const vendorFetch = vendorAnswering(200, { signed_url: euSignedUrl });
    const { visitor } = await embedWorkspace({ vendorFetch, voice: { ...boundVoice, runtime: { ...boundVoice.runtime, region: "eu" } } });

    const response = await (await visitor()).startVoiceSession().expect(200);

    expect(vendorFetch.mock.calls[0][0]).toBe("https://api.eu.residency.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_42");
    expect(response.body.signedUrl).toBe(euSignedUrl);
  });

  it("mints a new session key for every start", async () => {
    const { visitor } = await embedWorkspace({ vendorFetch: vendorAnswering(200, { signed_url: SIGNED_URL }) });
    const { startVoiceSession } = await visitor();

    const first = await startVoiceSession().expect(200);
    const second = await startVoiceSession().expect(200);

    expect(first.body.sessionKey).not.toBe(second.body.sessionKey);
  });

  it.each([
    ["voice is off for the agent", { ...boundVoice, enabled: false }],
    ["the agent is bound to no vendor agent", { ...boundVoice, runtime: null }],
  ])("answers 404 and asks the vendor nothing when %s", async (_case, voice) => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { visitor } = await embedWorkspace({ voice, vendorFetch });
    const { startVoiceSession } = await visitor();

    const response = await startVoiceSession().expect(404);

    expect(response.body.error.code).toBe("not_found");
    expect(vendorFetch).not.toHaveBeenCalled();
  });

  it("answers one 503 with no detail when the workspace holds no key, and when the vendor refuses", async () => {
    const noKeyFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const noKey = await embedWorkspace({ vendorKey: null, vendorFetch: noKeyFetch });
    const refused = await embedWorkspace({ vendorFetch: vendorAnswering(401, { detail: { status: "invalid_api_key" } }) });

    const missing = await (await noKey.visitor()).startVoiceSession().expect(503);
    const vendorFailed = await (await refused.visitor()).startVoiceSession().expect(503);

    expect(missing.body).toEqual(vendorFailed.body);
    expect(missing.body.error).toEqual({ code: "voice_unavailable", message: expect.any(String) });
    expect(JSON.stringify(vendorFailed.body)).not.toContain("invalid_api_key");
    expect(noKeyFetch).not.toHaveBeenCalled();
  });

  it("answers 503 for a stored key the backend has no master key to read, and counts it as unreadable", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { visitor, repositories, operator, dependencies } = await embedWorkspace({
      vendorKey: null,
      vendorFetch,
      envOverrides: { CONNECTOR_ENCRYPTION_KEY: undefined, METRICS_ENABLED: true, METRICS_AUTH_TOKEN: "metrics-test-token" },
    });
    await repositories.workspaceProviderCredentialsRepository.upsert({
      workspaceId: operator.workspaceId,
      provider: "elevenlabs",
      ciphertext: "v1:stored-under-a-key-this-backend-no-longer-has",
    });

    const response = await (await visitor()).startVoiceSession().expect(503);

    expect(response.body.error.code).toBe("voice_unavailable");
    expect(vendorFetch).not.toHaveBeenCalled();
    expect(startOutcomes(dependencies.metricsRegistry?.renderPrometheus() ?? "")).toEqual([
      expect.stringContaining('outcome="credential_unreadable"'),
    ]);
  });

  it("starts nothing without the visitor's public session, or from a site the embed does not admit", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { visitor } = await embedWorkspace({ vendorFetch });
    const { startVoiceSession } = await visitor();

    await startVoiceSession({}, { "x-radioso-public-session": "" }).expect(404);
    await startVoiceSession({}, { Origin: "https://not-approved.example.com" }).expect(404);
    expect(vendorFetch).not.toHaveBeenCalled();
  });

  it("starts nothing for a public link session, which no origin binds", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { app, anonymousChatToken } = await embedWorkspace({ vendorFetch });
    const session = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/sessions`)
      .send({ channel: "anonymous_link" })
      .expect(200);

    const response = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/voice/sessions`)
      .set("x-radioso-public-session", session.body.publicSessionToken as string)
      .send({})
      .expect(404);

    expect(response.body.error.code).toBe("not_found");
    expect(vendorFetch).not.toHaveBeenCalled();
  });

  it("refuses a locale that is not a language tag", async () => {
    const { visitor } = await embedWorkspace({ vendorFetch: vendorAnswering(200, { signed_url: SIGNED_URL }) });

    await (await visitor()).startVoiceSession({ locale: "{{system__locale}}" }).expect(400);
  });

  it("gives each visitor session its own small budget, which a fresh cookie does not refill", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { visitor } = await embedWorkspace({
      vendorFetch,
      envOverrides: { PUBLIC_VOICE_SESSION_START_RATE_LIMIT_MAX_ATTEMPTS: 2, PUBLIC_VOICE_SESSION_START_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 10 },
    });
    const first = await visitor();
    const second = await visitor();

    await first.startVoiceSession().expect(200);
    await first.startVoiceSession().expect(200);
    const limited = await first.startVoiceSession().expect(429);
    // The public session check mints a new rate-limit cookie for a caller that sends none; a
    // forged or fresh one changes nothing, because the budget follows the signed session.
    await first.startVoiceSession({}, { Cookie: `anon_rl_${randomUUID()}=forged.value` }).expect(429);
    await second.startVoiceSession().expect(200);
    await second.startVoiceSession().expect(200);
    await second.startVoiceSession().expect(429);

    expect(limited.body.error.code).toBe("rate_limit_exceeded");
    expect(vendorFetch).toHaveBeenCalledTimes(4);
  });

  it("runs a caller out of starts at its source budget, however many public sessions it mints", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { visitor } = await embedWorkspace({ vendorFetch });

    // Each start comes from a fresh public session, so each session budget is untouched.
    for (let start = 0; start < 3; start += 1) await (await visitor()).startVoiceSession().expect(200);
    const limited = await (await visitor()).startVoiceSession().expect(429);

    expect(limited.body.error.code).toBe("rate_limit_exceeded");
    expect(vendorFetch).toHaveBeenCalledTimes(3);
  });

  it("caps the workspace's starts across visitors", async () => {
    const vendorFetch = vendorAnswering(200, { signed_url: SIGNED_URL });
    const { visitor } = await embedWorkspace({
      vendorFetch,
      envOverrides: { PUBLIC_VOICE_SESSION_START_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 2, PUBLIC_VOICE_SESSION_START_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 10 },
    });

    await (await visitor()).startVoiceSession().expect(200);
    await (await visitor()).startVoiceSession().expect(200);
    await (await visitor()).startVoiceSession().expect(429);

    expect(vendorFetch).toHaveBeenCalledTimes(2);
  });

  it("joins the call's first turn to the website visitor who started it, and a self-minted key's to none", async () => {
    const { app, dependencies, operator, agentId, visitor } = await embedWorkspace({
      vendorFetch: vendorAnswering(200, { signed_url: SIGNED_URL }),
    });
    const visitorKey = randomUUID();
    const started = await (await visitor({ visitorKey })).startVoiceSession().expect(200);
    const credential = await dependencies.accessGrantService.issueGrant({
      agentId,
      workspaceId: operator.workspaceId,
      principalKind: "agent-api",
      channel: "agent-api",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const chatTurns = vi.spyOn(dependencies.assistantChatService, "streamAnswer");
    const callTurn = (sessionKey: string) =>
      request(app)
        .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
        .set("Authorization", `Bearer ${credential.token}`)
        .send({ messages: [{ role: "user", content: "When do you open?" }], stream: false, elevenlabs_extra_body: { session_key: sessionKey } })
        .expect(200);

    await callTurn(started.body.sessionKey as string);
    await callTurn(started.body.sessionKey as string);
    await callTurn(randomUUID());

    // The chat turn groups a new conversation by this key, exactly as the embed's own chat does.
    expect(chatTurns.mock.calls.map(([turn]) => turn.visitorKey)).toEqual([visitorKey, undefined, undefined]);
    expect(chatTurns.mock.calls[1]?.[0].conversationId).toEqual(expect.any(String));
  });

  it("tells the website embed it can talk when the operator offers calls there and the agent's voice is ready", async () => {
    const { embedConfig } = await embedWorkspace({ voiceCallsOffered: true });

    const config = await embedConfig();

    expect(config.body.voice).toEqual({ available: true });
    expect(JSON.stringify(config.body)).not.toContain("agent_42");
    expect(JSON.stringify(config.body)).not.toContain("elevenlabs");
  });

  it.each([
    ["the operator has not offered calls on the website, though voice is ready", {}],
    ["the operator turned calls off, though voice is ready", { voiceCallsOffered: false }],
    ["voice is off for the agent", { voiceCallsOffered: true, voice: { ...boundVoice, enabled: false } }],
    ["the agent is bound to no vendor agent", { voiceCallsOffered: true, voice: { ...boundVoice, runtime: null } }],
    ["the workspace holds no vendor key", { voiceCallsOffered: true, vendorKey: null }],
  ])("tells the website embed it cannot talk when %s", async (_case, options) => {
    const { embedConfig } = await embedWorkspace(options);

    const config = await embedConfig();

    expect(config.body.voice).toEqual({ available: false });
  });

  it("keeps the switch on the agent's website embed block, off until the operator turns it on, and untouched by other embed edits", async () => {
    const { app, dashboard, agentId } = await embedWorkspace();
    const readSwitch = async () =>
      (await request(app).get(`/api/v1/agents/${agentId}`).set(dashboard).expect(200)).body.surfaceSettings.websiteEmbed.voiceCallsOffered;

    expect(await readSwitch()).toBe(false);

    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ surfaceSettings: { websiteEmbed: { voiceCallsOffered: true } } }).expect(200);
    expect(await readSwitch()).toBe(true);

    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ surfaceSettings: { websiteEmbed: { launcherLabel: "Ask us" } } }).expect(200);
    await request(app).put("/api/v1/settings/general").set(dashboard).send({ websiteEmbedLauncherLabel: "Talk to us" }).expect(200);
    expect(await readSwitch()).toBe(true);
  });

  describe("the dashboard's view of voice readiness", () => {
    it("serves the readiness gaps the voice domain lists, and no others", () => {
      const document = createOpenApiDocument() as { components: { schemas: Record<string, { properties: Record<string, { enum?: unknown[] }> }> } };

      // `missing` is null when the voice is ready, so the nullable enum lists null beside the gaps.
      expect(document.components.schemas.VoiceCallReadiness.properties.missing.enum).toEqual([...VOICE_CALL_READINESS_GAPS, null]);
    });

    const readReadiness = async (app: Parameters<typeof request>[0], dashboard: Record<string, string>, agentId: string) =>
      (await request(app).get(`/api/v1/agents/${agentId}`).set(dashboard).expect(200)).body.voiceCallReadiness;

    it("reads ready when voice is on, a vendor agent is bound and the key can be read", async () => {
      const { app, dashboard, agentId } = await embedWorkspace();

      expect(await readReadiness(app, dashboard, agentId)).toEqual({ ready: true, missing: null });
    });

    it.each([
      ["the voice channel", { voice: { ...boundVoice, enabled: false } }, "voice_channel"],
      ["the runtime", { voice: { ...boundVoice, runtime: null } }, "runtime"],
      ["the vendor key", { vendorKey: null }, "vendor_key"],
    ])("names %s when it is what is missing", async (_piece, options, missing) => {
      const { app, dashboard, agentId } = await embedWorkspace(options);

      expect(await readReadiness(app, dashboard, agentId)).toEqual({ ready: false, missing });
    });

    it("names the encryption, and offers no calls on the website, when a key is stored but the backend cannot read it", async () => {
      const { app, dashboard, agentId, repositories, operator, embedConfig } = await embedWorkspace({
        vendorKey: null,
        voiceCallsOffered: true,
        envOverrides: { CONNECTOR_ENCRYPTION_KEY: undefined },
      });
      await repositories.workspaceProviderCredentialsRepository.upsert({
        workspaceId: operator.workspaceId,
        provider: "elevenlabs",
        ciphertext: "v1:stored-under-a-key-this-backend-no-longer-has",
      });

      expect(await readReadiness(app, dashboard, agentId)).toEqual({ ready: false, missing: "encryption" });
      expect((await embedConfig()).body.voice).toEqual({ available: false });
    });
  });

  it("records who turned calls on the website on or off, with ids and booleans only", async () => {
    const { app, dashboard, agentId, dependencies, operator } = await embedWorkspace();
    const voiceCallEvents = () => (dependencies.auditService as unknown as {
      events: Array<{ eventType: string; metadata?: Record<string, unknown>; workspaceId?: string; accountId?: string | null }>;
    }).events.filter((event) => event.eventType === "website_embed.voice_calls_offered.changed");

    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ surfaceSettings: { websiteEmbed: { voiceCallsOffered: true } } }).expect(200);
    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ surfaceSettings: { websiteEmbed: { launcherLabel: "Ask us" } } }).expect(200);
    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ surfaceSettings: { websiteEmbed: { voiceCallsOffered: false } } }).expect(200);

    expect(voiceCallEvents()).toEqual([
      expect.objectContaining({ workspaceId: operator.workspaceId, eventStatus: "success", metadata: { agentId, before: false, after: true } }),
      expect.objectContaining({ workspaceId: operator.workspaceId, eventStatus: "success", metadata: { agentId, before: true, after: false } }),
    ]);
  });

  it("still serves the agent to the dashboard when the credential store cannot be read, without its voice readiness", async () => {
    const { app, dashboard, agentId, repositories } = await embedWorkspace();
    vi.spyOn(repositories.workspaceProviderCredentialsRepository, "findByWorkspaceAndProvider").mockRejectedValue(new Error("connection refused"));

    const response = await request(app).get(`/api/v1/agents/${agentId}`).set(dashboard).expect(200);

    expect(response.body.id).toBe(agentId);
    expect(response.body).not.toHaveProperty("voiceCallReadiness");
  });

  it("drops the CDN-cached embed config when the workspace stores or removes its vendor key, so the Talk button follows at once", async () => {
    const invalidateForToken = vi.fn(async () => undefined);
    const { app, dashboard, launchToken } = await embedWorkspace({ vendorKey: null, embedConfigCacheInvalidator: { invalidateForToken } });
    invalidateForToken.mockClear();

    await request(app).put("/api/v1/settings/credentials/elevenlabs").set(dashboard).send({ apiKey: VENDOR_KEY }).expect(204);
    expect(invalidateForToken).toHaveBeenCalledWith(launchToken);

    invalidateForToken.mockClear();
    await request(app).delete("/api/v1/settings/credentials/elevenlabs").set(dashboard).expect(204);
    expect(invalidateForToken).toHaveBeenCalledWith(launchToken);
  });

  it("leaves the embed config cached when a model provider key changes", async () => {
    const invalidateForToken = vi.fn(async () => undefined);
    const { app, dashboard } = await embedWorkspace({ embedConfigCacheInvalidator: { invalidateForToken } });
    invalidateForToken.mockClear();

    await request(app).put("/api/v1/settings/credentials/openai").set(dashboard).send({ apiKey: "sk-test-0123456789" }).expect(204);

    expect(invalidateForToken).not.toHaveBeenCalled();
  });
});
