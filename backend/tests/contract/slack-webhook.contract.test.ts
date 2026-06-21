import { createHmac } from "node:crypto";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createSlackWebhookRouter } from "../../src/modules/connectors/plugins/slack/slackWebhook.js";
import type { SlackInstallationRecord } from "../../src/modules/slack/install/slackInstallationService.js";

const signingSecret = "test-signing-secret";
const nowMs = Date.parse("2026-06-19T12:00:00.000Z");

const createSignedHeaders = (body: string, timestamp = Math.floor(nowMs / 1000).toString()) => {
  const base = `v0:${timestamp}:${body}`;
  return {
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`,
  };
};

const createApp = (input: {
  createInboundEvent?: (eventId: string) => Promise<boolean>;
  botUserId?: string;
  botLoop?: boolean;
  handle?: () => Promise<void>;
  processingRetryDelaysMs?: readonly number[];
} = {}) => {
  const app = express();
  app.use((req, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      (req as typeof req & { rawBody?: Buffer }).rawBody = rawBody;
      req.body = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
      next();
    });
  });
  const handleMessageIm = vi.fn(input.handle ?? (async () => undefined));
  const handleAppMention = vi.fn(input.handle ?? (async () => undefined));
  const markInboundEventStatus = vi.fn(async () => undefined);
  const installation: SlackInstallationRecord = {
    id: "installation-1",
    connectionId: "connection-1",
    workspaceId: "workspace-1",
    teamId: "TTEST",
    teamName: "Test Slack",
    botUserId: input.botUserId ?? "UBOT",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  app.use("/api/connectors/slack", createSlackWebhookRouter({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    signingSecret,
    now: () => nowMs,
    processingRetryDelaysMs: input.processingRetryDelaysMs,
    installations: {
      findById: async () => installation,
      findByTeamId: async () => installation,
      findByWorkspaceId: async () => installation,
      upsert: async () => installation,
      removeByWorkspaceId: async () => false,
    },
    persistence: {
      createInboundEvent: async ({ eventId }) => input.createInboundEvent?.(eventId) ?? true,
      markInboundEventStatus,
    },
    messageHandler: {
      handleMessageIm,
      handleAppMention,
      isBotLoop: (_installation, event) => input.botLoop === true || Boolean(event.bot_id) || event.user === installation.botUserId,
    },
  }));
  return { app, handleMessageIm, handleAppMention, markInboundEventStatus };
};

const messagePayload = (eventId = "Ev1", overrides: Record<string, unknown> = {}) => ({
  token: "ignored",
  type: "event_callback",
  team_id: "TTEST",
  event_id: eventId,
  event: {
    type: "message",
    channel_type: "im",
    channel: "DUSER",
    user: "UUSER",
    text: "Question",
    ts: "1718800000.000100",
    ...overrides,
  },
});

const appMentionPayload = (eventId = "EvMention", overrides: Record<string, unknown> = {}) => ({
  token: "ignored",
  type: "event_callback",
  team_id: "TTEST",
  event_id: eventId,
  event: {
    type: "app_mention",
    channel: "C123",
    user: "UUSER",
    text: "<@UBOT> Question",
    ts: "1718800000.000200",
    ...overrides,
  },
});

describe("Slack inbound webhook contract", () => {
  it("responds to url_verification challenge", async () => {
    const { app } = createApp();
    const body = JSON.stringify({ type: "url_verification", challenge: "challenge-value" });
    const response = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body))
      .type("application/json")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ challenge: "challenge-value" });
  });

  it("rejects bad signatures and stale timestamps", async () => {
    const { app } = createApp();
    const body = JSON.stringify(messagePayload());

    const bad = await request(app)
      .post("/api/connectors/slack/events")
      .set({ ...createSignedHeaders(body), "X-Slack-Signature": "v0=bad" })
      .type("application/json")
      .send(body);
    expect(bad.status).toBe(401);

    const staleTimestamp = Math.floor(nowMs / 1000 - 301).toString();
    const stale = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body, staleTimestamp))
      .type("application/json")
      .send(body);
    expect(stale.status).toBe(401);
  });

  it("dedupes by event_id and suppresses bot-authored loops", async () => {
    const duplicate = createApp({ createInboundEvent: async () => false });
    const duplicateBody = JSON.stringify(messagePayload("EvDuplicate"));
    const duplicateResponse = await request(duplicate.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(duplicateBody))
      .type("application/json")
      .send(duplicateBody);
    expect(duplicateResponse.status).toBe(200);
    expect(duplicate.handleMessageIm).not.toHaveBeenCalled();

    const bot = createApp();
    const botBody = JSON.stringify(messagePayload("EvBot", { bot_id: "B123" }));
    const botResponse = await request(bot.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(botBody))
      .type("application/json")
      .send(botBody);
    expect(botResponse.status).toBe(200);
    expect(bot.handleMessageIm).not.toHaveBeenCalled();
    expect(bot.markInboundEventStatus).toHaveBeenCalledWith("EvBot", "skipped");
  });

  it("fast-acks before async message processing finishes", async () => {
    let release!: () => void;
    const processing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, handleMessageIm } = createApp({ handle: async () => processing });
    const body = JSON.stringify(messagePayload("EvAsync"));
    const response = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body))
      .type("application/json")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.text).toBe("OK");
    await vi.waitFor(() => expect(handleMessageIm).toHaveBeenCalledTimes(1));
    release();
  });

  it("marks async processing failures so accepted events do not remain received forever", async () => {
    const { app, handleMessageIm, markInboundEventStatus } = createApp({
      processingRetryDelaysMs: [],
      handle: async () => {
        throw new Error("chat_unavailable");
      },
    });
    const body = JSON.stringify(messagePayload("EvFailure"));
    const response = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body))
      .type("application/json")
      .send(body);

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(handleMessageIm).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(markInboundEventStatus).toHaveBeenCalledWith("EvFailure", "failed"));
  });

  it("retries async processing failures before marking an event failed", async () => {
    let attempts = 0;
    const { app, handleMessageIm, markInboundEventStatus } = createApp({
      processingRetryDelaysMs: [0],
      handle: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary_chat_unavailable");
        }
      },
    });
    const body = JSON.stringify(messagePayload("EvRetry"));
    const response = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body))
      .type("application/json")
      .send(body);

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(handleMessageIm).toHaveBeenCalledTimes(2));
    expect(markInboundEventStatus).not.toHaveBeenCalledWith("EvRetry", "failed");
  });

  it("dispatches app_mention events and ignores ordinary channel messages", async () => {
    const mention = createApp();
    const mentionBody = JSON.stringify(appMentionPayload("EvMention"));
    const mentionResponse = await request(mention.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(mentionBody))
      .type("application/json")
      .send(mentionBody);
    expect(mentionResponse.status).toBe(200);
    await vi.waitFor(() => expect(mention.handleAppMention).toHaveBeenCalledWith({
      eventId: "EvMention",
      teamId: "TTEST",
      event: expect.objectContaining({
        type: "app_mention",
        channel: "C123",
        user: "UUSER",
        text: "<@UBOT> Question",
        ts: "1718800000.000200",
      }),
    }));
    expect(mention.handleMessageIm).not.toHaveBeenCalled();

    const channelMessage = createApp();
    const channelBody = JSON.stringify(messagePayload("EvChannel", { channel_type: "channel", channel: "C123" }));
    const channelResponse = await request(channelMessage.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(channelBody))
      .type("application/json")
      .send(channelBody);
    expect(channelResponse.status).toBe(200);
    expect(channelMessage.handleMessageIm).not.toHaveBeenCalled();
    expect(channelMessage.handleAppMention).not.toHaveBeenCalled();
    expect(channelMessage.markInboundEventStatus).toHaveBeenCalledWith("EvChannel", "skipped");
  });
});
