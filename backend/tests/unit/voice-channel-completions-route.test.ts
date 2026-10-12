import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { Router } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { admittedAbuseControlDecision } from "../support/fakes.js";
import { createAgentRoutes } from "../../src/app/http/routes/agentRoutes.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import type { AccessGrant } from "../../src/modules/accessGrants/domain.js";
import type { VoiceTurnEvent, VoiceTurnInput } from "../../src/modules/voiceChannel/domain.js";
import { registerOpenAiCompletionsRoute } from "../../src/modules/voiceChannel/public.js";

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
    expect(chunks.map((chunk) => chunk.choices[0])).toEqual([
      { index: 0, delta: { role: "assistant", content: "We open at nine. " }, finish_reason: null },
      { index: 0, delta: { content: "See you then!" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(chunks[0]).toMatchObject({ object: "chat.completion.chunk", model: "radioso-voice" });

    expect(dependencies.accessGrantService.resolveAgentChannelGrant).toHaveBeenCalledWith("voice-secret", "agent-api");
    expect(dependencies.voiceTurns.runTurn).toHaveBeenCalledWith({
      session: { workspaceId, agentId, vendor: "elevenlabs", sessionKey: "conv_abc" },
      transport: "web",
      utterance: "When do you open?",
    }, expect.any(AbortSignal));
    expect(dependencies.accessGrantService.recordAgentChannelChatSucceeded).toHaveBeenCalledWith({
      grant: expect.objectContaining({ id: grant().id, agentId }),
    });
    expect(dependencies.abuseControlService.enforceBatch).toHaveBeenCalledWith([
      expect.objectContaining({ scope: "agent.channel.chat.grant", subjectKey: `grant:${grant().id}` }),
      expect.objectContaining({ scope: "agent.channel.chat.workspace", subjectKey: `workspace:${workspaceId}:global` }),
    ]);
  });

  it("answers the request ElevenLabs sends, turning only its newest user message into the utterance", async () => {
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
    }, expect.any(AbortSignal));
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
    }), expect.any(AbortSignal));
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

    expect(dependencies.voiceTurns.runTurn).not.toHaveBeenCalled();
    expect(dependencies.logger.warn).toHaveBeenCalledTimes(3);
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
    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[0] ?? "")).toMatchObject({
      choices: [{ index: 0, delta: { role: "assistant", content: "We open at nine. " }, finish_reason: null }],
    });
    expect(frames[1]).toBe('{"error":{"message":"The agent could not finish this reply.","type":"server_error"}}');
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
