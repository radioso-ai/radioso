import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/index.js";
import type { TestExecutionEvent, TestExecutionService } from "../../src/modules/test-execution/testExecution.js";
import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { conflict, forbidden, notFound } from "../../src/shared/domain/errors.js";
import { testChatSessionKey } from "../../src/modules/voiceChannel/testChatSessionDomain.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const VENDOR_KEY = "xi-workspace-secret-0123456789";
const SIGNED_URL = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const boundVoice = { enabled: true, bridgeLines: {}, fallbackLine: {}, runtime: { vendor: "elevenlabs", agentId: "agent_42", region: "us" } };
const csrf = { "X-Radioso-CSRF": "1" };

/** The published agent's chat: what a website caller hears. */
const publishedChat: ChatGateway = {
  answer: async () => "The published agent answers.",
  async *streamAnswer() {
    yield "The published agent answers.";
  },
};

/**
 * Test Chat's private tests as the test-execution module answers them: a single test whose spoken
 * turn the draft answers, recording what it was asked.
 */
const testExecutionsAnswering = (options: { opening?: () => Promise<{ greeting: string | null }> } = {}) => {
  const spokenTurns: Array<{ executionId: string; message: string; accountId: string | null }> = [];
  const service = {
    spokenSessionOpening: vi.fn(options.opening ?? (async () => ({ greeting: "Hi, I'm the draft." }))),
    async *streamSpokenMessage(input: { executionId: string; message: string; accountId: string | null }): AsyncGenerator<TestExecutionEvent> {
      spokenTurns.push({ executionId: input.executionId, message: input.message, accountId: input.accountId });
      const identity = { executionId: input.executionId, generation: 1, turnId: randomUUID(), attemptId: randomUUID(), sideId: randomUUID() };
      yield { type: "side_started", ...identity };
      yield { type: "message_delta", ...identity, delta: "The draft answers." };
      yield { type: "side_completed", ...identity, messageId: randomUUID(), answer: "The draft answers." };
      yield { type: "execution_completed", executionId: identity.executionId, generation: 1, turnId: identity.turnId, attemptId: identity.attemptId };
    },
  };
  return { service: service as unknown as TestExecutionService, spokenSessionOpening: service.spokenSessionOpening, spokenTurns };
};

const operatorWith = async (options: { opening?: () => Promise<{ greeting: string | null }>; voice?: object } = {}) => {
  const tests = testExecutionsAnswering(options);
  const vendorFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ signed_url: SIGNED_URL }), { status: 200, headers: { "content-type": "application/json" } }));
  const created = createTestApp({
    testExecutionService: tests.service,
    voiceVendorFetch: vendorFetch,
    chatGateway: publishedChat,
    envOverrides: { METRICS_ENABLED: true, METRICS_AUTH_TOKEN: "metrics-test-token" },
  });
  const { app, dependencies } = created;
  const operator = await issueTestSession(app, `test-chat-voice-${randomUUID()}@example.com`);
  const dashboard = adminSessionHeaders(operator);
  const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
  const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
  await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ voice: options.voice ?? boundVoice }).expect(200);
  await request(app).put("/api/v1/settings/credentials/elevenlabs").set(dashboard).send({ apiKey: VENDOR_KEY }).expect(204);
  const executionId = randomUUID();
  const start = (headers: Record<string, string> = { ...dashboard, ...csrf }, body: object = {}) =>
    request(app).post(`/api/v1/agents/${agentId}/test-executions/${executionId}/voice-sessions`).set(headers).send(body);
  const runtimeCredential = await dependencies.accessGrantService.issueGrant({
    agentId,
    workspaceId: operator.workspaceId,
    principalKind: "agent-api",
    channel: "agent-api",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + 600_000),
  });
  /** The vendor's custom LLM call for one caller turn on a session. */
  const turn = (sessionKey: string, content: string) => request(app)
    .post(`/api/v1/agents/${agentId}/voice/elevenlabs/v1/chat/completions`)
    .set("Authorization", `Bearer ${runtimeCredential.token}`)
    .send({ messages: [{ role: "user", content }], stream: false, elevenlabs_extra_body: { session_key: sessionKey } });
  /** A runtime of the operator's own on the generic dialect, with its own session key. */
  const genericTurn = (sessionKey: string, content: string) => request(app)
    .post(`/api/v1/agents/${agentId}/voice/generic/v1/chat/completions`)
    .set({ Authorization: `Bearer ${runtimeCredential.token}`, "x-radioso-voice-session": sessionKey })
    .send({ messages: [{ role: "user", content }], stream: false });
  return { ...created, ...tests, operator, dashboard, agentId, executionId, start, turn, genericTurn, vendorFetch };
};

describe("starting a voice session from Test Chat (#1536)", () => {
  it("starts a session on the agent's vendor agent for the test, and hands the page what it needs, never the key", async () => {
    const { start, spokenSessionOpening, operator, agentId, executionId } = await operatorWith();

    const response = await start().expect(200);

    expect(response.body).toEqual({
      vendor: "elevenlabs",
      signedUrl: SIGNED_URL,
      sessionKey: expect.stringMatching(/^radioso-test-chat_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      locale: "en",
      expiresAt: expect.any(String),
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toContain(VENDOR_KEY);
    expect(spokenSessionOpening).toHaveBeenCalledWith({ workspaceId: operator.workspaceId, agentId, executionId });
  });

  it("runs the session's turns on the test, so the caller hears the draft and no conversation is started", async () => {
    const { start, turn, spokenTurns, executionId, app, dashboard } = await operatorWith();
    const { sessionKey } = (await start().expect(200)).body as { sessionKey: string };

    const answered = await turn(sessionKey, "Who am I talking to?").expect(200);

    expect(answered.body.choices[0].message.content).toBe("The draft answers.");
    expect(answered.headers["x-radioso-conversation-id"]).toBeUndefined();
    expect(spokenTurns).toEqual([{ executionId, message: "Who am I talking to?", accountId: expect.any(String) }]);
    const history = await request(app).get("/api/v1/history/chat").set(dashboard).expect(200);
    expect((history.body.conversations as Array<{ channelContext?: { sessionKey?: string } | null }>)
      .some((conversation) => conversation.channelContext?.sessionKey === sessionKey)).toBe(false);
  });

  it("leaves a session nobody started from Test Chat on the published agent's path", async () => {
    const { turn, spokenTurns } = await operatorWith();

    const answered = await turn(randomUUID(), "Who am I talking to?").expect(200);

    // The published agent's chat answers it as a conversation, which the response names.
    expect(answered.headers["x-radioso-conversation-id"]).toEqual(expect.any(String));
    expect(answered.body.choices[0].message.content).not.toContain("The draft answers.");
    expect(spokenTurns).toEqual([]);
  });

  it.each([
    ["a version 8 UUID", "33333333-3333-8333-8333-333333333333"],
    ["a key in Test Chat's form", testChatSessionKey("44444444-4444-4444-8444-444444444444")],
  ])("runs an operator's own key on the generic dialect, %s, as a conversation", async (_case, sessionKey) => {
    const { genericTurn, spokenTurns } = await operatorWith();

    const answered = await genericTurn(sessionKey, "Who am I talking to?").expect(200);

    expect(answered.headers["x-radioso-conversation-id"]).toEqual(expect.any(String));
    expect(spokenTurns).toEqual([]);
  });

  it("refuses a Test Chat key Radioso minted whose session it holds no record of, and never answers it as the published agent", async () => {
    const { turn, spokenTurns, app, dashboard } = await operatorWith();
    const sessionKey = testChatSessionKey("55555555-5555-4555-8555-555555555555");

    const refused = await turn(sessionKey, "Who am I talking to?");

    expect(refused.status).toBe(404);
    expect(refused.headers["x-radioso-conversation-id"]).toBeUndefined();
    expect(spokenTurns).toEqual([]);
    const history = await request(app).get("/api/v1/history/chat").set(dashboard).expect(200);
    expect((history.body.conversations as Array<{ channelContext?: { sessionKey?: string } | null }>)
      .some((conversation) => conversation.channelContext?.sessionKey === sessionKey)).toBe(false);
  });

  it("counts the start on the test_chat surface", async () => {
    const { start, dependencies } = await operatorWith();

    await start().expect(200);

    const starts = (dependencies.metricsRegistry?.renderPrometheus() ?? "").split("\n").filter((line) => line.startsWith("radioso_voice_session_start_total{"));
    expect(starts).toEqual([expect.stringMatching(/surface="test_chat".*outcome="started"|outcome="started".*surface="test_chat"/)]);
  });

  it("asks for the CSRF header, a dashboard session, and the agent manage permission", async () => {
    const { start, dashboard, dependencies } = await operatorWith();

    await start(dashboard).expect(403);
    await start({ ...csrf }).expect(401);

    const requirePermission = dependencies.accountAccessService.requirePermission.bind(dependencies.accountAccessService);
    vi.spyOn(dependencies.accountAccessService, "requirePermission").mockImplementation(async (input) => {
      if (input.permission === "workspace.agents.manage") throw forbidden("Insufficient permissions");
      return requirePermission(input);
    });
    await start().expect(403);
  });

  it("refuses an API token: only a dashboard session starts a Test Chat call", async () => {
    const { start, dependencies, operator } = await operatorWith();
    const personal = await dependencies.personalCredentialService.issue({
      accountId: operator.accountId,
      workspaceId: operator.workspaceId,
      userId: operator.userId,
      label: "Test Chat voice contract",
      roleCeiling: "admin",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await start({ Authorization: `Bearer ${personal.secret}`, "X-Workspace-Id": operator.workspaceId, ...csrf });

    expect([401, 403]).toContain(response.status);
  });

  it.each([
    ["a test that is gone", async () => { throw notFound("Test execution is unavailable."); }, 404],
    ["a comparison", async () => { throw conflict("Only a single test takes spoken turns."); }, 409],
  ])("refuses %s without asking the vendor", async (_case, opening, status) => {
    const { start, vendorFetch } = await operatorWith({ opening });

    await start().expect(status);
    expect(vendorFetch).not.toHaveBeenCalled();
  });

  it("answers 404 when the agent's voice is not ready", async () => {
    const { start } = await operatorWith({ voice: { ...boundVoice, enabled: false } });

    const response = await start().expect(404);
    expect(response.body.error.code).toBe("not_found");
  });

  it("is in the API contract, beside the website embed's start", () => {
    const document = createOpenApiDocument() as unknown as { paths: Record<string, Record<string, { operationId?: string }>> };

    expect(document.paths["/api/v1/agents/{agentId}/test-executions/{executionId}/voice-sessions"]?.post?.operationId).toBe("startAgentTestExecutionVoiceSession");
  });
});
