import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { Router } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { admittedAbuseControlDecision } from "../support/fakes.js";
import { createAgentRoutes } from "../../src/app/http/routes/agentRoutes.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import type { AccessGrant } from "../../src/modules/accessGrants/domain.js";
import type { ChatStreamEvent } from "../../src/modules/chat/contracts/index.js";
import { defaultAgentVoiceSettings } from "../../src/modules/agents/public.js";
import type { VoiceTurnEvent, VoiceTurnInput, VoiceTurnOutcome } from "../../src/modules/voiceChannel/domain.js";
import { registerOpenAiCompletionsRoute, VoiceTurnService } from "../../src/modules/voiceChannel/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const otherAgentId = "33333333-3333-4333-8333-333333333333";
const conversationId = "55555555-5555-4555-8555-555555555555";

const grant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
  id: "44444444-4444-4444-8444-444444444444",
  agentId,
  workspaceId,
  label: "Voice vendor",
  principalKind: "agent-api",
  role: "agent",
  channel: "agent-api",
  tokenPrefix: "rdso_api",
  tokenHash: "hash",
  encryptedToken: null,
  originConstraint: { mode: "allow-all", origins: [] },
  enabled: true,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
  ...overrides,
});

const spokenTurn: VoiceTurnEvent[] = [
  { type: "conversation", conversationId },
  { type: "speech", text: "We open at nine. ", last: false },
  { type: "speech", text: "See you then!", last: true },
  { type: "outcome", outcome: { kind: "continue" } },
];

const voiceTurns = (events: VoiceTurnEvent[] = spokenTurn) => ({
  runTurn: vi.fn((_input: VoiceTurnInput, _signal: AbortSignal) => (async function* () {
    for (const event of events) yield event;
  })()),
});

const createDependencies = (overrides: Partial<AppDependencies> = {}): AppDependencies => ({
  env: {
    AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
    AGENT_CHANNEL_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 12,
    AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS: 3,
    AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 9,
    RADIOSO_TRUSTED_PROXY_HOPS: 0,
  },
  accessGrantService: {
    resolveAgentChannelGrant: vi.fn().mockResolvedValue(grant()),
    evaluate: vi.fn().mockReturnValue({ allowed: true }),
    recordAuthFailure: vi.fn().mockResolvedValue(undefined),
    recordAgentChannelChatSucceeded: vi.fn().mockResolvedValue(undefined),
  },
  abuseControlService: {
    enforce: vi.fn().mockResolvedValue(admittedAbuseControlDecision()),
    enforceBatch: vi.fn().mockResolvedValue([admittedAbuseControlDecision()]),
  },
  auditService: { record: vi.fn().mockResolvedValue(undefined) },
  agentRepository: {
    findByIdAndWorkspaceId: vi.fn().mockResolvedValue({ id: agentId, workspaceId }),
  },
  voiceTurns: voiceTurns(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...overrides,
} as unknown as AppDependencies);

const createApp = (dependencies = createDependencies()) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/agents", createAgentRoutes(dependencies));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = (error as { statusCode?: number })?.statusCode ?? 500;
    res.status(statusCode).json({ code: (error as { code?: string }).code ?? "internal_error" });
  });
  return app;
};

const completionsPath = (dialect = "elevenlabs", pathAgentId = agentId) =>
  `/api/v1/agents/${pathAgentId}/voice/${dialect}/v1/chat/completions`;

const elevenlabsBody = (overrides: Record<string, unknown> = {}) => ({
  model: "radioso-voice",
  stream: true,
  messages: [
    { role: "system", content: "You are a helpful agent." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello! How can I help?" },
    { role: "user", content: [{ type: "text", text: "When do you open?" }] },
  ],
  tools: [{ type: "function", function: { name: "end_call", parameters: { type: "object" } } }],
  elevenlabs_extra_body: { session_key: "conv_abc" },
  ...overrides,
});

const dataFrames = (body: string): string[] => body.split("\n\n").filter(Boolean).map((frame) => frame.slice("data: ".length));

describe("voice completions route", () => {
  it("streams the agent's reply as OpenAI chat.completion.chunk frames ending in [DONE]", async () => {
    const dependencies = createDependencies();

    const response = await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody())
      .expect(200);

    expect(response.headers["content-type"]).toMatch(/^text\/event-stream/u);
    expect(response.headers["x-radioso-conversation-id"]).toBe(conversationId);
    const frames = dataFrames(response.text);
    expect(frames.at(-1)).toBe("[DONE]");
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame) as {
      id: string;
      object: string;
      model: string;
      choices: Array<{ index: number; delta: Record<string, string>; finish_reason: string | null }>;
    });
    // ElevenLabs speaks a sentence once its terminator is followed by whitespace and a later non-blank delta.
    expect(chunks.map((chunk) => chunk.choices[0])).toEqual([
      { index: 0, delta: { role: "assistant", content: "We open at nine. " }, finish_reason: null },
      { index: 0, delta: { content: " \u200B" }, finish_reason: null },
      { index: 0, delta: { content: "See you then!" }, finish_reason: null },
      { index: 0, delta: { content: " \u200B" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(chunks[0]).toMatchObject({ object: "chat.completion.chunk", model: "radioso-voice" });

    expect(dependencies.accessGrantService.resolveAgentChannelGrant).toHaveBeenCalledWith("voice-secret", "agent-api");
    expect(dependencies.voiceTurns.runTurn).toHaveBeenCalledWith({
      session: { workspaceId, agentId, vendor: "elevenlabs", sessionKey: "conv_abc" },
      transport: "web",
      utterance: "When do you open?",
      minReleasableSentenceChars: 45,
    }, expect.any(AbortSignal), expect.any(AbortSignal));
    expect(dependencies.accessGrantService.recordAgentChannelChatSucceeded).toHaveBeenCalledWith({
      grant: expect.objectContaining({ id: grant().id, agentId }),
    });
    expect(dependencies.abuseControlService.enforceBatch).toHaveBeenCalledWith([
      expect.objectContaining({ scope: "agent.channel.chat.grant", subjectKey: `grant:${grant().id}` }),
      expect.objectContaining({ scope: "agent.channel.chat.workspace", subjectKey: `workspace:${workspaceId}:global` }),
    ]);
  });

  it("answers the request ElevenLabs sends, turning its newest user message into the utterance and its cut-off reply into what was heard", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send({
        model: "radioso",
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 8192,
        temperature: 0,
        tools: [],
        messages: [
          { role: "system", content: "ElevenLabs task prompt" },
          { role: "user", content: "Do you have yoga on Sundays?" },
          { role: "assistant", content: "Thanks for asking, let me..." },
          { role: "user", content: "And on Saturdays?" },
        ],
        elevenlabs_extra_body: { session_key: "6d0c3f0e-9c55-4c1b-8d7e-1f7f5a2b9e40" },
      })
      .expect(200);

    expect(dependencies.voiceTurns.runTurn).toHaveBeenCalledWith({
      session: { workspaceId, agentId, vendor: "elevenlabs", sessionKey: "6d0c3f0e-9c55-4c1b-8d7e-1f7f5a2b9e40" },
      transport: "web",
      utterance: "And on Saturdays?",
      heardUntil: "Thanks for asking, let me",
      minReleasableSentenceChars: 45,
    }, expect.any(AbortSignal), expect.any(AbortSignal));
  });

  it("rejects the placeholder bearer ElevenLabs sends when the agent has no secret", async () => {
    const dependencies = createDependencies({
      accessGrantService: {
        resolveAgentChannelGrant: vi.fn().mockResolvedValue(null),
        evaluate: vi.fn().mockReturnValue({ allowed: true }),
        recordAuthFailure: vi.fn().mockResolvedValue(undefined),
        recordAgentChannelChatSucceeded: vi.fn().mockResolvedValue(undefined),
      } as unknown as AppDependencies["accessGrantService"],
    });

    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer not_provided")
      .send(elevenlabsBody())
      .expect(401);

    expect(dependencies.accessGrantService.resolveAgentChannelGrant).toHaveBeenCalledWith("not_provided", "agent-api");
    expect(dependencies.voiceTurns.runTurn).not.toHaveBeenCalled();
  });

  it("answers a non-streaming request with one chat.completion object", async () => {
    const response = await request(createApp())
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ stream: false }))
      .expect(200);

    expect(response.headers["x-radioso-conversation-id"]).toBe(conversationId);
    expect(response.body).toMatchObject({
      object: "chat.completion",
      model: "radioso-voice",
      choices: [{ index: 0, message: { role: "assistant", content: "We open at nine. See you then!" }, finish_reason: "stop" }],
    });
  });

  it("streams the generic dialect's reply without flush deltas", async () => {
    const dependencies = createDependencies({
      voiceTurns: voiceTurns([
        { type: "conversation", conversationId },
        { type: "bridge", text: "Let me check." },
        { type: "speech", text: "We open at nine.", last: true },
        { type: "outcome", outcome: { kind: "continue" } },
      ]),
    });

    const response = await request(createApp(dependencies))
      .post(completionsPath("generic"))
      .set("Authorization", "Bearer voice-secret")
      .set("X-Radioso-Voice-Session", "room-7")
      .send({ stream: true, messages: [{ role: "user", content: "When do you open?" }] })
      .expect(200);

    const deltas = dataFrames(response.text).slice(0, -1).map((frame) =>
      (JSON.parse(frame) as { choices: [{ delta: Record<string, string> }] }).choices[0].delta);
    expect(deltas).toEqual([
      { role: "assistant", content: "Let me check." },
      { content: "We open at nine." },
      {},
    ]);
  });

  it("follows an ElevenLabs bridge line with a flush delta so it is spoken at once", async () => {
    const dependencies = createDependencies({
      voiceTurns: voiceTurns([
        { type: "conversation", conversationId },
        { type: "bridge", text: "Let me check." },
        { type: "speech", text: "We open at nine.", last: true },
        { type: "outcome", outcome: { kind: "continue" } },
      ]),
    });

    const response = await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody())
      .expect(200);

    const contents = dataFrames(response.text).slice(0, -1).map((frame) =>
      (JSON.parse(frame) as { choices: [{ delta: { content?: string } }] }).choices[0].delta.content);
    expect(contents).toEqual(["Let me check.", " \u200B", "We open at nine.", " \u200B", undefined]);
  });

  it("passes on the caller's locale where the dialect reads it, and ignores one that is not a language tag", async () => {
    const dependencies = createDependencies();
    const app = createApp(dependencies);

    await request(app)
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ elevenlabs_extra_body: { session_key: "conv_abc", locale: "it-IT" } }))
      .expect(200);
    await request(app)
      .post(completionsPath("generic"))
      .set("Authorization", "Bearer voice-secret")
      .set("X-Radioso-Voice-Session", "room-7")
      .set("X-Radioso-Voice-Locale", "de")
      .send({ messages: [{ role: "user", content: "Hallo" }] })
      .expect(200);
    await request(app)
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ elevenlabs_extra_body: { session_key: "conv_abc", locale: "Italian" } }))
      .expect(200);

    await request(app)
      .post(completionsPath("generic"))
      .set("Authorization", "Bearer voice-secret")
      .set("X-Radioso-Voice-Session", "room-7")
      .set("X-Radioso-Voice-Locale", "German")
      .send({ messages: [{ role: "user", content: "Hallo" }], metadata: { locale: "de-AT" } })
      .expect(200);

    const inputs = vi.mocked(dependencies.voiceTurns.runTurn).mock.calls.map(([turn]) => turn);
    expect(inputs[0]).toMatchObject({ locale: "it-IT", minReleasableSentenceChars: 45 });
    expect(inputs[1]).toMatchObject({ locale: "de" });
    expect(inputs[1]).not.toHaveProperty("minReleasableSentenceChars");
    expect(inputs[2]).not.toHaveProperty("locale");
    // A malformed header falls through to the next source.
    expect(inputs[3]).toMatchObject({ locale: "de-AT" });
  });

  it("reads the generic dialect's session key from its header", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(completionsPath("generic"))
      .set("Authorization", "Bearer voice-secret")
      .set("X-Radioso-Voice-Session", "room-7")
      .send({ messages: [{ role: "user", content: "Hello" }] })
      .expect(200);

    expect(dependencies.voiceTurns.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      session: { workspaceId, agentId, vendor: "generic", sessionKey: "room-7" },
      utterance: "Hello",
    }), expect.any(AbortSignal), expect.any(AbortSignal));
  });

  it("rejects a request without an agent channel credential", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies)).post(completionsPath()).send(elevenlabsBody()).expect(401);

    expect(dependencies.voiceTurns.runTurn).not.toHaveBeenCalled();
  });

  it("rejects a credential bound to another agent", async () => {
    const dependencies = createDependencies({
      accessGrantService: {
        resolveAgentChannelGrant: vi.fn().mockResolvedValue(grant({ agentId: otherAgentId })),
        evaluate: vi.fn().mockReturnValue({ allowed: true }),
        recordAuthFailure: vi.fn().mockResolvedValue(undefined),
        recordAgentChannelChatSucceeded: vi.fn().mockResolvedValue(undefined),
      } as unknown as AppDependencies["accessGrantService"],
    });

    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody())
      .expect(401);

    expect(dependencies.accessGrantService.recordAuthFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "agent_mismatch", surface: "agent-api" }),
    );
    expect(dependencies.voiceTurns.runTurn).not.toHaveBeenCalled();
  });

  it("returns 404 for a dialect it does not speak", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(completionsPath("vapi"))
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody())
      .expect(404);

    expect(dependencies.voiceTurns.runTurn).not.toHaveBeenCalled();
  });

  it("returns 400 when no message comes from the user", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ messages: [{ role: "system", content: "You are a helpful agent." }] }))
      .expect(400);

    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ messages: [{ role: "user", content: "   " }] }))
      .expect(400);

    expect(dependencies.voiceTurns.runTurn).not.toHaveBeenCalled();
  });

  it("returns 400 when the dialect finds no session key, and names only the dialect and agent in the log", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ elevenlabs_extra_body: {} }))
      .expect(400);

    // A user id spans calls; it never joins them into one conversation.
    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ elevenlabs_extra_body: undefined, user_id: "user_9" }))
      .expect(400);

    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ elevenlabs_extra_body: { session_key: "k".repeat(300) } }))
      .expect(400);

    // An uninterpolated placeholder is the same key on every call; taking it would merge them all.
    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ elevenlabs_extra_body: { session_key: "{{system__conversation_id}}" } }))
      .expect(400);

    expect(dependencies.voiceTurns.runTurn).not.toHaveBeenCalled();
    expect(dependencies.logger.warn).toHaveBeenCalledTimes(4);
    for (const [fields] of vi.mocked(dependencies.logger.warn).mock.calls) {
      expect(fields).toEqual({ dialect: "elevenlabs", agentId });
    }
  });

  it("returns 400 for an utterance longer than a chat message may be", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ messages: [{ role: "user", content: "x".repeat(4_001) }] }))
      .expect(400);

    expect(dependencies.voiceTurns.runTurn).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that is not a chat-completions request", async () => {
    await request(createApp())
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send({ messages: "When do you open?" })
      .expect(400);
  });

  it("ends a stream that fails after its first frame with one generic OpenAI error frame", async () => {
    const failing = {
      runTurn: vi.fn(() => (async function* (): AsyncGenerator<VoiceTurnEvent> {
        yield { type: "conversation", conversationId };
        yield { type: "speech", text: "We open at nine. ", last: false };
        throw new Error("provider down: internal detail");
      })()),
    };

    const response = await request(createApp(createDependencies({ voiceTurns: failing })))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody())
      .expect(200);

    const frames = dataFrames(response.text);
    expect(frames).toHaveLength(3);
    expect(JSON.parse(frames[0] ?? "")).toMatchObject({
      choices: [{ index: 0, delta: { role: "assistant", content: "We open at nine. " }, finish_reason: null }],
    });
    expect(frames[2]).toBe('{"error":{"message":"The agent could not finish this reply.","type":"server_error"}}');
    expect(response.text).not.toContain("internal detail");
    expect(response.text).not.toContain("[DONE]");
  });

  it("answers with the turn's error status when the turn fails before it speaks", async () => {
    const failing = {
      runTurn: vi.fn(() => (async function* (): AsyncGenerator<VoiceTurnEvent> {
        throw Object.assign(new Error("limit"), { statusCode: 429, code: "usage_limit" });
      })()),
    };

    const response = await request(createApp(createDependencies({ voiceTurns: failing })))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody())
      .expect(429);

    expect(response.body).toEqual({ code: "usage_limit" });
  });
});

describe("voice completions route when the vendor disconnects mid-reply", () => {
  it("writes nothing after the close and aborts the turn only once the ceiling passes", async () => {
    const ceilingMs = 150;
    let turnSignal: AbortSignal | undefined;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const turns = {
      runTurn: (_input: VoiceTurnInput, signal: AbortSignal) => {
        turnSignal = signal;
        return (async function* (): AsyncGenerator<VoiceTurnEvent> {
          yield { type: "conversation", conversationId };
          yield { type: "speech", text: "We open at nine. ", last: false };
          await released;
          yield { type: "speech", text: "See you then!", last: true };
          yield { type: "outcome", outcome: { kind: "continue" } };
        })();
      },
    };

    const writesAfterClose: unknown[] = [];
    let responseClosed: Promise<unknown> | undefined;
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      let closed = false;
      responseClosed = once(res, "close").then(() => { closed = true; });
      const write = res.write.bind(res) as (...args: unknown[]) => boolean;
      res.write = ((...args: unknown[]) => {
        if (closed) writesAfterClose.push(args[0]);
        return write(...args);
      }) as typeof res.write;
      next();
    });
    const router = Router();
    registerOpenAiCompletionsRoute(router, {
      turns,
      admission: { handlers: [], callerOf: () => ({ workspaceId, agentId }), onTurnAccepted: () => undefined },
      logger: { warn: vi.fn() },
      disconnectAbortCeilingMs: ceilingMs,
    });
    app.use("/api/v1/agents", router);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const { port } = server.address() as AddressInfo;
      const client = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: completionsPath(),
        headers: { "content-type": "application/json" },
      });
      client.on("error", () => undefined);
      client.end(JSON.stringify(elevenlabsBody()));
      const [response] = await once(client, "response") as [http.IncomingMessage];
      response.on("error", () => undefined);
      await once(response, "data");
      client.destroy();
      await responseClosed;
      const closedAt = Date.now();

      expect(turnSignal?.aborted).toBe(false);
      await vi.waitFor(() => expect(turnSignal?.aborted).toBe(true), { timeout: 2_000, interval: 10 });
      expect(Date.now() - closedAt).toBeGreaterThanOrEqual(ceilingMs - 20);

      release();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(writesAfterClose).toEqual([]);
    } finally {
      release();
      server.close();
    }
  });
});

describe("voice completions route keep-alive", () => {
  // Only the clock is fake: sockets and setImmediate stay real so frames can travel.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flushIo = async (): Promise<void> => {
    for (let tick = 0; tick < 20; tick += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  /** A turn that names its conversation, says nothing for `silenceMs`, answers, then drains for `drainMs`. */
  const silentTurn = (silenceMs: number) => ({
    runTurn: (_input: VoiceTurnInput, _signal: AbortSignal) => (async function* (): AsyncGenerator<VoiceTurnEvent> {
      yield { type: "conversation", conversationId };
      await new Promise((resolve) => setTimeout(resolve, silenceMs));
      yield { type: "speech", text: "We open at nine.", last: true };
      yield { type: "outcome", outcome: { kind: "continue" } };
    })(),
  });

  interface Arrival { atMs: number; delta: unknown }

  const streamOnFakeClock = async (options: {
    dialect: "elevenlabs" | "generic";
    turns: ReturnType<typeof silentTurn>;
    runForMs: number;
    hangUpAfterFirstFrame?: boolean;
  }) => {
    const writesAfterClose: unknown[] = [];
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      let closed = false;
      res.on("close", () => { closed = true; });
      const write = res.write.bind(res) as (...args: unknown[]) => boolean;
      res.write = ((...args: unknown[]) => {
        if (closed) writesAfterClose.push(args[0]);
        return write(...args);
      }) as typeof res.write;
      next();
    });
    let turnStarted = false;
    const router = Router();
    registerOpenAiCompletionsRoute(router, {
      turns: {
        runTurn: (input, signal) => {
          turnStarted = true;
          return options.turns.runTurn(input, signal);
        },
      },
      admission: { handlers: [], callerOf: () => ({ workspaceId, agentId }), onTurnAccepted: () => undefined },
      logger: { warn: vi.fn() },
    });
    app.use("/api/v1/agents", router);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const startedAt = Date.now();
    const arrivals: Arrival[] = [];

    try {
      const { port } = server.address() as AddressInfo;
      const client = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: completionsPath(options.dialect),
        headers: { "content-type": "application/json", "x-radioso-voice-session": "room-7" },
      });
      client.on("error", () => undefined);
      client.on("response", (response) => {
        response.on("error", () => undefined);
        response.on("data", (chunk: Buffer) => {
          for (const frame of dataFrames(chunk.toString("utf8"))) {
            arrivals.push({
              atMs: Date.now() - startedAt,
              delta: frame === "[DONE]" ? frame : (JSON.parse(frame) as { choices: [{ delta: unknown }] }).choices[0].delta,
            });
          }
          if (options.hangUpAfterFirstFrame) client.destroy();
        });
      });
      client.end(JSON.stringify(options.dialect === "elevenlabs"
        ? elevenlabsBody()
        : { stream: true, messages: [{ role: "user", content: "When do you open?" }] }));

      // The turn starts once the request has crossed the socket, at fake time zero.
      for (let attempt = 0; attempt < 100 && !turnStarted; attempt += 1) await flushIo();
      expect(turnStarted).toBe(true);
      for (let elapsed = 0; elapsed < options.runForMs; elapsed += 100) {
        await vi.advanceTimersByTimeAsync(100);
        await flushIo();
      }
      client.destroy();
      return { arrivals, writesAfterClose };
    } finally {
      server.closeAllConnections();
      server.close();
    }
  };

  it("sends an invisible keep-alive delta at 2.5 s and 5 s of an ElevenLabs turn's silence", async () => {
    const { arrivals } = await streamOnFakeClock({ dialect: "elevenlabs", turns: silentTurn(6_000), runForMs: 7_000 });

    expect(arrivals).toEqual([
      { atMs: 2_500, delta: { role: "assistant", content: "" } },
      { atMs: 2_500, delta: { content: " \u200B" } },
      { atMs: 5_000, delta: { content: " \u200B" } },
      { atMs: 6_000, delta: { content: "We open at nine." } },
      { atMs: 6_000, delta: { content: " \u200B" } },
      { atMs: 6_000, delta: {} },
      { atMs: 6_000, delta: "[DONE]" },
    ]);
  });

  it("sends no keep-alive on the generic dialect", async () => {
    const { arrivals } = await streamOnFakeClock({ dialect: "generic", turns: silentTurn(6_000), runForMs: 7_000 });

    expect(arrivals).toEqual([
      { atMs: 6_000, delta: { role: "assistant", content: "We open at nine." } },
      { atMs: 6_000, delta: {} },
      { atMs: 6_000, delta: "[DONE]" },
    ]);
  });

  it("sends no keep-alive after the stop frame", async () => {
    const { arrivals, writesAfterClose } = await streamOnFakeClock({
      dialect: "elevenlabs",
      turns: silentTurn(100),
      runForMs: 11_000,
    });

    expect(arrivals.at(-1)).toEqual({ atMs: 100, delta: "[DONE]" });
    expect(arrivals.filter(({ atMs }) => atMs > 100)).toEqual([]);
    expect(writesAfterClose).toEqual([]);
  });

  it("sends no keep-alive after the runtime hangs up", async () => {
    const { arrivals, writesAfterClose } = await streamOnFakeClock({
      dialect: "elevenlabs",
      turns: silentTurn(9_000),
      runForMs: 10_000,
      hangUpAfterFirstFrame: true,
    });

    expect(arrivals.every(({ atMs }) => atMs === 2_500)).toBe(true);
    expect(writesAfterClose).toEqual([]);
  });
});

describe("voice completions route when a newer utterance supersedes the turn", () => {
  it("ends the superseded turn's stream with stop and [DONE] after what it already spoke, and no error frame", async () => {
    const chat = {
      streamTurn: () => (async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: "conversation", conversationId };
        yield { type: "chunk", text: "We open at nine. See" };
        yield { type: "cancelled", conversationId, reason: "superseded", stage: "persisting" };
      })(),
    };
    const turns = new VoiceTurnService({
      sessions: { findConversationId: async () => conversationId, bind: async (_session, id) => id },
      chat,
      agents: { findVoiceProfile: async () => ({ voice: defaultAgentVoiceSettings(), defaultLocale: null }) },
      routines: { isRoutineActive: async () => false },
      ownership: { isHumanOwned: async () => false },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const response = await request(createApp(createDependencies({ voiceTurns: turns })))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody())
      .expect(200);

    const frames = dataFrames(response.text);
    expect(frames.at(-1)).toBe("[DONE]");
    expect(frames.slice(0, -1).map((frame) => (JSON.parse(frame) as { choices: unknown[] }).choices[0])).toEqual([
      { index: 0, delta: { role: "assistant", content: "We open at nine. " }, finish_reason: null },
      { index: 0, delta: { content: " \u200B" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]);
    expect(response.text).not.toContain("error");
  });
});

describe("voice completions route hang-up signal", () => {
  const serve = async (turns: { runTurn: (input: VoiceTurnInput, signal: AbortSignal, hungUp?: AbortSignal) => AsyncIterable<VoiceTurnEvent> }) => {
    const app = express();
    app.use(express.json());
    const router = Router();
    registerOpenAiCompletionsRoute(router, {
      turns,
      admission: { handlers: [], callerOf: () => ({ workspaceId, agentId }), onTurnAccepted: () => undefined },
      logger: { warn: vi.fn() },
    });
    app.use("/api/v1/agents", router);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
  };

  it("fires when the runtime closes the request before the outcome, and not once the outcome was sent", async () => {
    const hangUps: AbortSignal[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const turns = {
      runTurn: (_input: VoiceTurnInput, _signal: AbortSignal, hungUp?: AbortSignal) => {
        if (hungUp) hangUps.push(hungUp);
        const holds = hangUps.length === 1;
        return (async function* (): AsyncGenerator<VoiceTurnEvent> {
          yield { type: "conversation", conversationId };
          yield { type: "speech", text: "We open at nine. ", last: false };
          if (holds) await released;
          yield { type: "speech", text: "See you then!", last: true };
          yield { type: "outcome", outcome: { kind: "continue" } };
        })();
      },
    };
    const server = await serve(turns);

    try {
      const { port } = server.address() as AddressInfo;
      const client = http.request({ host: "127.0.0.1", port, method: "POST", path: completionsPath(), headers: { "content-type": "application/json" } });
      client.on("error", () => undefined);
      client.end(JSON.stringify(elevenlabsBody()));
      const [response] = await once(client, "response") as [http.IncomingMessage];
      response.on("error", () => undefined);
      await once(response, "data");
      client.destroy();
      await vi.waitFor(() => expect(hangUps[0]?.aborted).toBe(true), { timeout: 2_000, interval: 10 });
      release();

      await request(server).post(completionsPath()).send(elevenlabsBody()).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(hangUps[1]?.aborted).toBe(false);
    } finally {
      release();
      server.close();
    }
  });
});


describe("voice completions route outcomes", () => {
  const outcomeTurn = (outcome: VoiceTurnOutcome): VoiceTurnEvent[] => [...spokenTurn.slice(0, -1), { type: "outcome", outcome }];
  const outcomes: Array<[VoiceTurnOutcome["kind"], VoiceTurnOutcome]> = [
    ["continue", { kind: "continue" }],
    ["callback_requested", { kind: "callback_requested", handoffReason: "routine_handoff" }],
  ];

  /** Posts over a real socket, so the response's trailers can be read once the stream ends. */
  const postOverHttp = async (dependencies: AppDependencies, body: unknown) => {
    const server = createApp(dependencies).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const client = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: completionsPath(),
        headers: { "content-type": "application/json", authorization: "Bearer voice-secret" },
      });
      client.end(JSON.stringify(body));
      const [response] = await once(client, "response") as [http.IncomingMessage];
      response.setEncoding("utf8");
      let text = "";
      response.on("data", (chunk: string) => { text += chunk; });
      await once(response, "end");
      return { headers: response.headers, trailers: response.trailers, text };
    } finally {
      server.close();
    }
  };

  it.each(outcomes)("names a %s outcome in the response header of a non-streaming reply, which is otherwise unchanged", async (kind, outcome) => {
    const response = await request(createApp(createDependencies({ voiceTurns: voiceTurns(outcomeTurn(outcome)) })))
      .post(completionsPath())
      .set("Authorization", "Bearer voice-secret")
      .send(elevenlabsBody({ stream: false }))
      .expect(200);

    expect(response.headers["x-radioso-voice-outcome"]).toBe(kind);
    expect(response.body).toMatchObject({
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "We open at nine. See you then!" }, finish_reason: "stop" }],
    });
    expect(JSON.stringify(response.body)).not.toContain("tool_calls");
  });

  it.each(outcomes)("ends a streamed %s turn with stop and [DONE] and names the outcome in a trailer", async (kind, outcome) => {
    const response = await postOverHttp(createDependencies({ voiceTurns: voiceTurns(outcomeTurn(outcome)) }), elevenlabsBody());

    const frames = dataFrames(response.text);
    expect(frames.at(-1)).toBe("[DONE]");
    expect(JSON.parse(frames.at(-2) ?? "{}")).toMatchObject({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    expect(response.text).not.toContain("tool_calls");
    // The stream's headers leave with its first frame, before the turn has an outcome.
    expect(response.headers.trailer).toBe("X-Radioso-Voice-Outcome");
    expect(response.headers).not.toHaveProperty("x-radioso-voice-outcome");
    expect(response.trailers["x-radioso-voice-outcome"]).toBe(kind);
  });

  describe("a turn that breaks the one-outcome rule", () => {
    const unfinished: VoiceTurnEvent[] = [
      { type: "conversation", conversationId },
      { type: "speech", text: "We open at nine. ", last: false },
    ];

    it.each([true, false])("answers an HTTP error when the turn ends without an outcome or a frame (stream %s)", async (stream) => {
      const response = await request(createApp(createDependencies({ voiceTurns: voiceTurns([{ type: "conversation", conversationId }]) })))
        .post(completionsPath())
        .set("Authorization", "Bearer voice-secret")
        .send(elevenlabsBody({ stream }))
        .expect(500);

      expect(response.headers["content-type"]).toMatch(/^application\/json/u);
      expect(response.headers).not.toHaveProperty("x-radioso-voice-outcome");
      expect(response.text).not.toContain("chat.completion");
    });

    it("answers an HTTP error, never a completion, when a non-streaming turn ends without an outcome after speaking", async () => {
      const response = await request(createApp(createDependencies({ voiceTurns: voiceTurns(unfinished) })))
        .post(completionsPath())
        .set("Authorization", "Bearer voice-secret")
        .send(elevenlabsBody({ stream: false }))
        .expect(500);

      expect(response.headers).not.toHaveProperty("x-radioso-voice-outcome");
      expect(response.text).not.toContain("We open at nine.");
    });

    it("ends a stream that spoke and then stopped without an outcome with the error frame alone", async () => {
      const response = await postOverHttp(createDependencies({ voiceTurns: voiceTurns(unfinished) }), elevenlabsBody());

      const frames = dataFrames(response.text);
      expect(JSON.parse(frames[0] ?? "{}")).toMatchObject({ choices: [{ delta: { content: "We open at nine. " } }] });
      expect(frames.at(-1)).toBe(JSON.stringify({ error: { message: "The agent could not finish this reply.", type: "server_error" } }));
      expect(frames).not.toContain("[DONE]");
      expect(response.text).not.toContain('"finish_reason":"stop"');
      expect(response.trailers).not.toHaveProperty("x-radioso-voice-outcome");
    });

    const trailing: Array<[string, VoiceTurnEvent]> = [
      ["a second outcome", { type: "outcome", outcome: { kind: "callback_requested", handoffReason: "routine_handoff" } }],
      ["speech after the outcome", { type: "speech", text: "Stale.", last: true }],
    ];

    it.each(trailing)("ends a stream with the error frame, not stop and [DONE], when the turn sends %s", async (_label, extra) => {
      let closed = false;
      const turns = {
        runTurn: vi.fn(() => (async function* (): AsyncGenerator<VoiceTurnEvent> {
          try {
            yield* spokenTurn;
            yield extra;
          } finally {
            closed = true;
          }
        })()),
      };

      const response = await postOverHttp(createDependencies({ voiceTurns: turns }), elevenlabsBody());

      const frames = dataFrames(response.text);
      expect(frames.at(-1)).toBe(JSON.stringify({ error: { message: "The agent could not finish this reply.", type: "server_error" } }));
      expect(frames).not.toContain("[DONE]");
      expect(response.text).not.toContain('"finish_reason":"stop"');
      expect(response.trailers).not.toHaveProperty("x-radioso-voice-outcome");
      expect(closed).toBe(true);
    });

    it.each(trailing)("answers an HTTP error, never a completion, when a non-streaming turn sends %s", async (_label, extra) => {
      const response = await request(createApp(createDependencies({ voiceTurns: voiceTurns([...spokenTurn, extra]) })))
        .post(completionsPath())
        .set("Authorization", "Bearer voice-secret")
        .send(elevenlabsBody({ stream: false }))
        .expect(500);

      expect(response.headers).not.toHaveProperty("x-radioso-voice-outcome");
      expect(response.text).not.toContain("chat.completion");
    });
  });

  describe("through the turn service", () => {
    const handOffDone = (fields: Record<string, unknown>): ChatStreamEvent => ({
      type: "done",
      conversationId,
      assistantMessageId: "66666666-6666-4666-8666-666666666666",
      answer: "Thanks, Ada. A teammate will call you back.",
      activitySummary: { stages: [] },
      activityTrace: { events: [] },
      route: { type: "direct", reason: "social_only" },
      ...fields,
    } as unknown as ChatStreamEvent);

    const turnService = (events: ChatStreamEvent[], humanOwned = false) => new VoiceTurnService({
      sessions: { findConversationId: async () => conversationId, bind: async (_session, id) => id },
      chat: { streamTurn: () => (async function* () { for (const event of events) yield event; })() },
      agents: { findVoiceProfile: async () => ({ voice: defaultAgentVoiceSettings(), defaultLocale: null }) },
      routines: { isRoutineActive: async () => false },
      ownership: { isHumanOwned: async () => humanOwned },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    it("finishes the response at the turn limit's outcome while the reply behind it is still draining", async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const drained = vi.fn();
      const fallback = "Sorry, this is taking much longer than it should, could you ask me again?";
      const logger = { info: vi.fn(), warn: vi.fn() };
      // A fresh service per request, so each one is a session's only turn.
      const limitedTurns = () => new VoiceTurnService({
        sessions: { findConversationId: async () => conversationId, bind: async (_session, id) => id },
        chat: {
          streamTurn: () => (async function* (): AsyncGenerator<ChatStreamEvent> {
            yield { type: "conversation", conversationId };
            await released;
            yield { type: "chunk", text: "We open at nine." };
            drained();
            yield handOffDone({});
          })(),
        },
        agents: {
          findVoiceProfile: async () => ({
            voice: { enabled: true, bridgeLines: {}, fallbackLine: { en: fallback } },
            defaultLocale: null,
          }),
        },
        routines: { isRoutineActive: async () => false },
        ownership: { isHumanOwned: async () => false },
        logger,
        timing: { bridgeAfterMs: 10_000, bridgeAfterComposingIdleMs: 10_000, turnLimitMs: 20, replayWindowMs: 30_000 },
      });

      try {
        const streamed = await postOverHttp(createDependencies({ voiceTurns: limitedTurns() }), elevenlabsBody());
        const answered = await request(createApp(createDependencies({ voiceTurns: limitedTurns() })))
          .post(completionsPath())
          .set("Authorization", "Bearer voice-secret")
          .send(elevenlabsBody({ stream: false }))
          .expect(200);

        expect(dataFrames(streamed.text).at(-1)).toBe("[DONE]");
        expect(streamed.trailers["x-radioso-voice-outcome"]).toBe("continue");
        expect(answered.body.choices[0].message.content).toBe(fallback);
        expect(drained).not.toHaveBeenCalled();
        // The turn is logged once its reply has drained, not when the response ended.
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        release();
      }
      await vi.waitFor(() => expect(drained).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(2));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ result: "completed", turnLimitReached: true, fallbackSpoken: true }),
        "Voice turn reached the turn limit",
      );
    });

    it("ends a replay with stop, [DONE] and its outcome, and settles the session, while the replay's audit note hangs", async () => {
      const answer = "We open at nine. See you then!";
      const logger = { info: vi.fn(), warn: vi.fn() };
      const streamTurn = vi.fn(() => (async function* (): AsyncGenerator<ChatStreamEvent> {
        yield { type: "conversation", conversationId };
        yield { type: "chunk", text: answer };
        yield handOffDone({ answer });
      })());
      const turns = new VoiceTurnService({
        sessions: { findConversationId: async () => conversationId, bind: async (_session, id) => id },
        chat: { streamTurn },
        agents: { findVoiceProfile: async () => ({ voice: defaultAgentVoiceSettings(), defaultLocale: null }) },
        routines: { isRoutineActive: async () => false },
        ownership: { isHumanOwned: async () => false },
        logger,
        // The audit store never answers the replay's note.
        notes: { replyInterrupted: vi.fn(async () => {}), replyReplayed: vi.fn(() => new Promise<void>(() => {})) },
      });
      // The runtime hung up on the session's first turn before its outcome, so its stored answer is replayable.
      const hungUp = new AbortController();
      hungUp.abort();
      const firstTurn: VoiceTurnInput = {
        session: { workspaceId, agentId, vendor: "elevenlabs", sessionKey: "conv_abc" },
        transport: "web",
        utterance: "When do you open?",
      };
      for await (const _event of turns.runTurn(firstTurn, new AbortController().signal, hungUp.signal)) {
        // Drained like the runtime that went away.
      }

      const replayed = await postOverHttp(createDependencies({ voiceTurns: turns }), elevenlabsBody());

      const frames = dataFrames(replayed.text);
      expect(frames.at(-1)).toBe("[DONE]");
      expect(JSON.parse(frames.at(-2) ?? "{}")).toMatchObject({ choices: [{ delta: {}, finish_reason: "stop" }] });
      expect(replayed.trailers["x-radioso-voice-outcome"]).toBe("continue");
      expect(streamTurn).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenLastCalledWith(expect.objectContaining({ result: "replayed" }), "Voice turn finished");

      // The replay settled as delivered, so the same utterance again runs a new turn.
      await postOverHttp(createDependencies({ voiceTurns: turns }), elevenlabsBody());
      expect(streamTurn).toHaveBeenCalledTimes(2);
    });

    it("requests a callback when the turn's routine handed the caller to a person after collecting a slot", async () => {
      const turns = turnService([
        { type: "conversation", conversationId },
        { type: "chunk", text: "Thanks, Ada. A teammate will call you back." },
        handOffDone({
          ownership: { state: "human_owned", suppressed: false },
          handoff: { reason: "routine_handoff", collectedSlotCount: 2 },
        }),
      ]);

      const response = await request(createApp(createDependencies({ voiceTurns: turns })))
        .post(completionsPath())
        .set("Authorization", "Bearer voice-secret")
        .send(elevenlabsBody({ stream: false }))
        .expect(200);

      expect(response.headers["x-radioso-voice-outcome"]).toBe("callback_requested");
      expect(response.body.choices[0].message.content).toBe("Thanks, Ada. A teammate will call you back.");
    });

    it("speaks chat's waiting message and continues when a person already owns the conversation", async () => {
      const waiting = "Thanks for waiting. A teammate has your message.";
      const turns = turnService([
        { type: "status", stage: "interpreting" },
        { type: "status", stage: "composing" },
        { type: "chunk", text: waiting },
        handOffDone({ assistantMessageId: "", answer: waiting, ownership: { state: "human_owned", suppressed: true } }),
      ], true);

      const response = await request(createApp(createDependencies({ voiceTurns: turns })))
        .post(completionsPath())
        .set("Authorization", "Bearer voice-secret")
        .send(elevenlabsBody({ stream: false }))
        .expect(200);

      expect(response.headers["x-radioso-voice-outcome"]).toBe("continue");
      expect(response.body.choices[0].message.content).toBe(waiting);
    });
  });
});
