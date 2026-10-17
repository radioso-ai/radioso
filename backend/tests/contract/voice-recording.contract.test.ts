import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestToken } from "../support/testApp.js";

const SITE = "https://example.com";
const VENDOR_KEY = "xi-workspace-secret-0123456789";
const VENDOR_CONVERSATION_ID = "conv_01jx8k2m3n4p5q6r7s8t9v0w1x";
const AUDIO = "ID3-fake-mp3-bytes";
const boundVoice = (region: "us" | "eu" = "eu") => ({
  enabled: true,
  bridgeLines: {},
  fallbackLine: {},
  runtime: { vendor: "elevenlabs", agentId: "agent_42", region },
});

type VendorFetch = typeof globalThis.fetch;

const urlOf = (input: Parameters<VendorFetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
type VendorAnswer = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

const signedUrlOf = (region: "us" | "eu") =>
  `wss://${region === "eu" ? "api.eu.residency.elevenlabs.io" : "api.elevenlabs.io"}/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig`;

/** The vendor as the test needs it: a signed URL for starts, and the recording endpoints as each case sets them. */
const vendorStandIn = (region: "us" | "eu", answers: { audio?: VendorAnswer; remove?: VendorAnswer } = {}) =>
  vi.fn<VendorFetch>(async (input, init) => {
    const url = urlOf(input);
    if (url.includes("/get-signed-url")) {
      return new Response(JSON.stringify({ signed_url: signedUrlOf(region) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/audio")) {
      return (answers.audio ?? (() => new Response(AUDIO, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(AUDIO.length) } })))(url, init);
    }
    if (init?.method === "DELETE") return (answers.remove ?? (() => new Response("{}", { status: 200 })))(url, init);
    return new Response("unexpected", { status: 500 });
  });

/**
 * A workspace whose website embed admits the test site, with the agent's voice bound to an
 * ElevenLabs agent in `region`, the workspace's ElevenLabs key stored, and a way to run a call: a
 * visitor starts a session, the page reports the vendor's conversation id, and the voice runtime
 * sends the session's first turn, which binds the conversation.
 */
const recordedWorkspace = async (options: { region?: "us" | "eu"; vendorFetch?: ReturnType<typeof vendorStandIn> } = {}) => {
  const region = options.region ?? "eu";
  const vendorFetch = options.vendorFetch ?? vendorStandIn(region);
  const created = createTestApp({ voiceVendorFetch: vendorFetch });
  const { app, dependencies } = created;
  const operator = await issueTestToken(app, `voice-recording-${randomUUID()}@example.com`);
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
  await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ voice: boundVoice(region) }).expect(200);
  await request(app).put("/api/v1/settings/credentials/elevenlabs").set(dashboard).send({ apiKey: VENDOR_KEY }).expect(204);
  const runtimeCredential = await dependencies.accessGrantService.issueGrant({
    agentId,
    workspaceId: operator.workspaceId,
    principalKind: "agent-api",
    channel: "agent-api",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + 600_000),
  });

  /** A website embed visitor with its public session. */
  const visitor = async () => {
    const session = await request(app)
      .post(`/api/v1/public/chat/${launchToken}/sessions`)
      .set("Origin", SITE)
      .send({ channel: "website_embed" })
      .expect(200);
    const publicSessionToken = session.body.publicSessionToken as string;
    const startCall = async () => {
      const started = await request(app)
        .post(`/api/v1/public/chat/${launchToken}/voice/sessions`)
        .set({ Origin: SITE, "x-radioso-public-session": publicSessionToken })
        .send({})
        .expect(200);
      return started.body.sessionKey as string;
    };
    const report = (sessionKey: string, body: object = { vendorConversationId: VENDOR_CONVERSATION_ID }, token = publicSessionToken) =>
      request(app)
        .post(`/api/v1/public/chat/${launchToken}/voice/sessions/${sessionKey}/vendor-conversation`)
        .set({ Origin: SITE, "x-radioso-public-session": token })
        .send(body);
    return { publicSessionToken, startCall, report };
  };

  /** The voice runtime's turn for a session; the first one binds the session's conversation. */
  const callTurn = async (sessionKey: string): Promise<string> => {
    await request(app)
      .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
      .set("Authorization", `Bearer ${runtimeCredential.token}`)
      .send({ messages: [{ role: "user", content: "When do you open?" }], stream: false, elevenlabs_extra_body: { session_key: sessionKey } })
      .expect(200);
    const history = await request(app).get("/api/v1/history/chat").set(dashboard).expect(200);
    const conversations = history.body.conversations as Array<{ id: string; channelContext?: { provider?: string; sessionKey?: string } | null }>;
    return conversations.find((conversation) => conversation.channelContext?.sessionKey === sessionKey)!.id;
  };

  /** A call whose page reported the vendor's conversation id, with its conversation. */
  const recordedCall = async () => {
    const { startCall, report } = await visitor();
    const sessionKey = await startCall();
    await report(sessionKey).expect(204);
    return { sessionKey, conversationId: await callTurn(sessionKey) };
  };

  const recordingEvents = (eventType: string) => (dependencies.auditService as unknown as {
    events: Array<{ eventType: string; workspaceId?: string | null; metadata?: Record<string, unknown> }>;
  }).events.filter((event) => event.eventType === eventType);

  return { ...created, vendorFetch, operator, dashboard, agentId, launchToken, anonymousChatToken, visitor, callTurn, recordedCall, recordingEvents };
};

describe("voice vendor conversation report contract", () => {
  it("takes the vendor's conversation id once, for a session Radioso started for this visitor", async () => {
    const { visitor } = await recordedWorkspace();
    const { startCall, report } = await visitor();
    const sessionKey = await startCall();

    const accepted = await report(sessionKey).expect(204);
    expect(accepted.headers["access-control-allow-origin"]).toBe(SITE);

    await report(sessionKey, { vendorConversationId: "conv_another" }).expect(404);
  });

  it("refuses another visitor's session, a key Radioso never minted, and a malformed or oversized id", async () => {
    const { visitor } = await recordedWorkspace();
    const first = await visitor();
    const second = await visitor();
    const sessionKey = await first.startCall();

    await second.report(sessionKey).expect(404);
    await first.report(randomUUID()).expect(404);
    await first.report("not-a-uuid").expect(400);
    await first.report(sessionKey, { vendorConversationId: "x".repeat(129) }).expect(400);
    await first.report(sessionKey, { vendorConversationId: "conv_1/../../v1/user" }).expect(400);
    await first.report(sessionKey, { vendorConversationId: VENDOR_CONVERSATION_ID, extra: true }).expect(400);
    await first.report(sessionKey).expect(204);
  });

  it("takes reports only from the website embed", async () => {
    const { app, anonymousChatToken } = await recordedWorkspace();
    const session = await request(app).post(`/api/v1/public/chat/${anonymousChatToken}/sessions`).send({ channel: "anonymous_link" }).expect(200);

    await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/voice/sessions/${randomUUID()}/vendor-conversation`)
      .set("x-radioso-public-session", session.body.publicSessionToken as string)
      .send({ vendorConversationId: VENDOR_CONVERSATION_ID })
      .expect(404);
  });
});

describe("voice recording contract", () => {
  it("tells a dashboard session that a voice conversation has a recording, without asking the vendor or naming it", async () => {
    const { app, dashboard, vendorFetch, recordedCall } = await recordedWorkspace();
    const { conversationId } = await recordedCall();
    vendorFetch.mockClear();

    const detail = await request(app).get(`/api/v1/history/chat/${conversationId}`).set(dashboard).expect(200);

    expect(detail.body.recording).toEqual({ available: true });
    expect(JSON.stringify(detail.body)).not.toContain(VENDOR_CONVERSATION_ID);
    expect(vendorFetch).not.toHaveBeenCalled();
    const legacy = await request(app).get(`/api/v1/history/${conversationId}`).set(dashboard).expect(200);
    expect(legacy.body.recording).toEqual({ available: true });
  });

  it("offers no recording for a call whose page never reported one, and none once the workspace's key is gone", async () => {
    const { app, dashboard, visitor, callTurn, recordedCall } = await recordedWorkspace();
    const { startCall } = await visitor();
    const unreported = await callTurn(await startCall());
    const reported = (await recordedCall()).conversationId;

    expect((await request(app).get(`/api/v1/history/chat/${unreported}`).set(dashboard).expect(200)).body.recording).toEqual({ available: false });

    await request(app).delete("/api/v1/settings/credentials/elevenlabs").set(dashboard).expect(204);
    expect((await request(app).get(`/api/v1/history/chat/${reported}`).set(dashboard).expect(200)).body.recording).toEqual({ available: false });
  });

  it("leaves the recording out for a machine credential and for a conversation that is not a call", async () => {
    const { app, dashboard, operator, recordedCall } = await recordedWorkspace();
    const { conversationId } = await recordedCall();

    const machine = await request(app).get(`/api/v1/history/chat/${conversationId}`).set("Authorization", `Bearer ${operator.token}`).expect(200);
    expect(machine.body).not.toHaveProperty("recording");

    const chat = await request(app).post("/api/v1/assistant/chat").set(dashboard).send({ message: "hello" }).expect(200);
    const textConversation = await request(app).get(`/api/v1/history/chat/${chat.body.conversationId as string}`).set(dashboard).expect(200);
    expect(textConversation.body).not.toHaveProperty("recording");
  });

  it("streams the recording from the vendor's region host with the workspace's key, uncached, and audits who played it", async () => {
    const { app, dashboard, operator, vendorFetch, recordedCall, recordingEvents } = await recordedWorkspace({ region: "eu" });
    const { conversationId } = await recordedCall();
    vendorFetch.mockClear();

    const played = await request(app).get(`/api/v1/conversations/${conversationId}/recording`).set(dashboard).buffer(true).parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done(null, Buffer.concat(chunks).toString("utf8")));
    }).expect(200);

    expect(played.body).toBe(AUDIO);
    expect(played.headers["content-type"]).toBe("audio/mpeg");
    expect(played.headers["cache-control"]).toBe("private, no-store");
    const [url, init] = vendorFetch.mock.calls[0];
    expect(url).toBe(`https://api.eu.residency.elevenlabs.io/v1/convai/conversations/${VENDOR_CONVERSATION_ID}/audio`);
    expect(init?.headers).toEqual({ "xi-api-key": VENDOR_KEY });
    expect(JSON.stringify(played.headers)).not.toContain(VENDOR_KEY);
    expect(JSON.stringify(played.headers)).not.toContain("elevenlabs.io");
    expect(recordingEvents("conversation.recording_played")).toEqual([
      expect.objectContaining({
        workspaceId: operator.workspaceId,
        eventStatus: "success",
        metadata: { conversationId, actorUserId: expect.any(String), vendor: "elevenlabs", partial: false },
      }),
    ]);
  });

  it("passes a byte range on and answers with the vendor's partial content", async () => {
    const vendorFetch = vendorStandIn("eu", {
      audio: () => new Response("3-f", { status: 206, headers: { "content-type": "audio/mpeg", "content-range": `bytes 3-5/${AUDIO.length}`, "content-length": "3" } }),
    });
    const { app, dashboard, recordedCall } = await recordedWorkspace({ vendorFetch });
    const { conversationId } = await recordedCall();

    const partial = await request(app).get(`/api/v1/conversations/${conversationId}/recording`).set({ ...dashboard, Range: "bytes=3-5" }).expect(206);

    expect(partial.headers["content-range"]).toBe(`bytes 3-5/${AUDIO.length}`);
    const audioCall = vendorFetch.mock.calls.find(([url]) => urlOf(url).endsWith("/audio"))!;
    expect(audioCall[1]?.headers).toEqual({ "xi-api-key": VENDOR_KEY, range: "bytes=3-5" });
  });

  it("answers 404 when the vendor holds no audio yet, and 503 when it cannot be read, auditing neither", async () => {
    let answer: () => Response = () => new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    const vendorFetch = vendorStandIn("eu", { audio: () => answer() });
    const { app, dashboard, recordedCall, recordingEvents } = await recordedWorkspace({ vendorFetch });
    const { conversationId } = await recordedCall();

    await request(app).get(`/api/v1/conversations/${conversationId}/recording`).set(dashboard).expect(404);
    answer = () => new Response(JSON.stringify({ detail: `bad key ${VENDOR_KEY}` }), { status: 401 });
    const failed = await request(app).get(`/api/v1/conversations/${conversationId}/recording`).set(dashboard).expect(503);

    expect(failed.body.error?.code ?? failed.body.code).toBe("recording_unavailable");
    expect(JSON.stringify(failed.body)).not.toContain(VENDOR_KEY);
    expect(recordingEvents("conversation.recording_played")).toEqual([]);
  });

  it("finds no recording for a conversation without one, in another workspace, or for a machine credential", async () => {
    const { app, dashboard, operator, visitor, callTurn, recordedCall } = await recordedWorkspace();
    const { startCall } = await visitor();
    const unreported = await callTurn(await startCall());
    const { conversationId } = await recordedCall();
    const stranger = await issueTestToken(app, `voice-recording-stranger-${randomUUID()}@example.com`);

    await request(app).get(`/api/v1/conversations/${unreported}/recording`).set(dashboard).expect(404);
    await request(app).get(`/api/v1/conversations/${randomUUID()}/recording`).set(dashboard).expect(404);
    await request(app).get(`/api/v1/conversations/${conversationId}/recording`).set(adminSessionHeaders(stranger)).expect(404);
    const machine = await request(app).get(`/api/v1/conversations/${conversationId}/recording`).set("Authorization", `Bearer ${operator.token}`);
    expect([401, 403]).toContain(machine.status);
    await request(app).get("/api/v1/conversations/not-a-uuid/recording").set(dashboard).expect(400);
  });

  it("asks the vendor to delete each recording when the workspace is deleted, and audits each deletion", async () => {
    const { app, operator, vendorFetch, recordedCall, recordingEvents } = await recordedWorkspace({ region: "eu" });
    const { conversationId } = await recordedCall();
    await request(app).post("/api/v1/workspace").set("Cookie", operator.cookie).send({ name: "Keep" }).expect(201);
    vendorFetch.mockClear();

    await request(app).delete(`/api/v1/workspace/${operator.workspaceId}`).set("Cookie", operator.cookie).expect(204);

    const deletes = vendorFetch.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes.map(([url]) => urlOf(url))).toEqual([`https://api.eu.residency.elevenlabs.io/v1/convai/conversations/${VENDOR_CONVERSATION_ID}`]);
    expect(deletes[0]?.[1]?.headers).toEqual({ "xi-api-key": VENDOR_KEY });
    expect(recordingEvents("conversation.recording_deleted")).toEqual([
      expect.objectContaining({
        workspaceId: null,
        metadata: { conversationId, vendor: "elevenlabs", deletedWorkspaceId: operator.workspaceId },
      }),
    ]);
  });

  it("deletes the workspace even when the vendor refuses to delete the recording", async () => {
    const vendorFetch = vendorStandIn("eu", { remove: () => new Response("{}", { status: 500 }) });
    const { app, operator, recordedCall, recordingEvents } = await recordedWorkspace({ vendorFetch });
    await recordedCall();
    await request(app).post("/api/v1/workspace").set("Cookie", operator.cookie).send({ name: "Keep" }).expect(201);

    await request(app).delete(`/api/v1/workspace/${operator.workspaceId}`).set("Cookie", operator.cookie).expect(204);

    const workspaces = await request(app).get("/api/v1/workspace").set("Cookie", operator.cookie).expect(200);
    expect((workspaces.body.workspaces as Array<{ id: string }>).map((workspace) => workspace.id)).not.toContain(operator.workspaceId);
    expect(recordingEvents("conversation.recording_deleted")).toEqual([]);
  });
});
