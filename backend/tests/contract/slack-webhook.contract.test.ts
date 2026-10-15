import { createHmac } from "node:crypto";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createSlackWebhookRouter } from "../../src/modules/connectors/plugins/slack/slackWebhook.js";
import { SLACK_INBOUND_EVENT_JOB } from "../../src/modules/connectors/plugins/slack/slackInboundEventJob.js";
import type { SlackInstallationRecord } from "../../src/modules/slack/install/slackInstallationService.js";
import type { BackgroundJobRequest } from "../../src/shared/background-jobs/index.js";

const signingSecret = "test-signing-secret";
const nowMs = Date.parse("2026-06-19T12:00:00.000Z");

const createSignedHeaders = (body: string, timestamp = Math.floor(nowMs / 1000).toString()) => {
  const base = `v0:${timestamp}:${body}`;
  return {
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`,
  };
};

/** Mirrors `PostgresSlackPersistence`'s dedupe contract on a Map instead of Postgres: the real
 *  transactional atomicity is covered by the Postgres integration test. */
const createInMemorySlackPersistence = () => {
  const statusByEventId = new Map<string, "received" | "processed" | "skipped" | "failed">();
  const enqueuedJobs: BackgroundJobRequest[] = [];
  return {
    enqueuedJobs,
    statusByEventId,
    createInboundEvent: vi.fn(async (
      { eventId }: { eventId: string },
      status: "received" | "skipped" = "received",
    ) => {
      if (statusByEventId.has(eventId)) {
        return false;
      }
      statusByEventId.set(eventId, status);
      return true;
    }),
    enqueueInboundEvent: vi.fn(async ({ eventId, job }: { eventId: string; teamId: string; job: BackgroundJobRequest }) => {
      if (statusByEventId.has(eventId)) {
        return "duplicate" as const;
      }
      statusByEventId.set(eventId, "received");
      enqueuedJobs.push(job);
      return "enqueued" as const;
    }),
  };
};

const createApp = (input: {
  botUserId?: string;
  persistence?: ReturnType<typeof createInMemorySlackPersistence>;
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
  const installation: SlackInstallationRecord = {
    id: "installation-1",
    connectionId: "connection-1",
    workspaceId: "workspace-1",
    accountId: "account-1",
    teamId: "TTEST",
    teamName: "Test Slack",
    botUserId: input.botUserId ?? "UBOT",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const persistence = input.persistence ?? createInMemorySlackPersistence();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  app.use("/api/connectors/slack", createSlackWebhookRouter({
    logger,
    signingSecret,
    now: () => nowMs,
    installations: {
      findByTeamId: async () => installation,
    },
    persistence,
  }));
  return { app, persistence, logger };
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

  it("enqueues a durable job and acks before anything runs", async () => {
    const { app, persistence } = createApp();
    const body = JSON.stringify(messagePayload("EvAsync"));
    const response = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body))
      .type("application/json")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.text).toBe("OK");
    expect(persistence.enqueuedJobs).toHaveLength(1);
    expect(persistence.enqueuedJobs[0]).toMatchObject({
      kind: SLACK_INBOUND_EVENT_JOB.kind,
      idempotencyKey: "EvAsync",
      payload: {
        eventId: "EvAsync",
        teamId: "TTEST",
        inbound: { kind: "im", event: expect.objectContaining({ channel: "DUSER", text: "Question" }) },
      },
    });
  });

  it("does not enqueue twice for a duplicate event id", async () => {
    const { app, persistence } = createApp();
    const body = JSON.stringify(messagePayload("EvDuplicate"));

    const first = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body))
      .type("application/json")
      .send(body);
    const second = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body))
      .type("application/json")
      .send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(persistence.enqueuedJobs).toHaveLength(1);
  });

  it("skips in one atomic write, never a separate status-update call", async () => {
    const { app, persistence } = createApp();
    const botBody = JSON.stringify(messagePayload("EvAtomicSkip", { bot_id: "B123" }));

    await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(botBody))
      .type("application/json")
      .send(botBody);

    expect(persistence.createInboundEvent).toHaveBeenCalledTimes(1);
    expect(persistence.createInboundEvent).toHaveBeenCalledWith({ eventId: "EvAtomicSkip", teamId: "TTEST" }, "skipped");
    expect(persistence.statusByEventId.get("EvAtomicSkip")).toBe("skipped");
  });

  it("dedupes by event_id and suppresses bot-authored loops without enqueuing a job", async () => {
    const duplicatePersistence = createInMemorySlackPersistence();
    duplicatePersistence.statusByEventId.set("EvDuplicate", "received");
    const duplicate = createApp({ persistence: duplicatePersistence });
    const duplicateBody = JSON.stringify(messagePayload("EvDuplicate"));
    const duplicateResponse = await request(duplicate.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(duplicateBody))
      .type("application/json")
      .send(duplicateBody);
    expect(duplicateResponse.status).toBe(200);
    expect(duplicate.persistence.enqueuedJobs).toHaveLength(0);

    const bot = createApp();
    const botBody = JSON.stringify(messagePayload("EvBot", { bot_id: "B123" }));
    const botResponse = await request(bot.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(botBody))
      .type("application/json")
      .send(botBody);
    expect(botResponse.status).toBe(200);
    expect(bot.persistence.enqueuedJobs).toHaveLength(0);
    expect(bot.persistence.statusByEventId.get("EvBot")).toBe("skipped");
  });

  it("dispatches app_mention events into the job payload with the mention kind", async () => {
    const mention = createApp();
    const mentionBody = JSON.stringify(appMentionPayload("EvMention"));
    const mentionResponse = await request(mention.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(mentionBody))
      .type("application/json")
      .send(mentionBody);
    expect(mentionResponse.status).toBe(200);
    expect(mention.persistence.enqueuedJobs[0]).toMatchObject({
      payload: {
        eventId: "EvMention",
        teamId: "TTEST",
        inbound: {
          kind: "mention",
          event: expect.objectContaining({ channel: "C123", user: "UUSER", text: "<@UBOT> Question" }),
        },
      },
    });
  });

  it("dispatches public and private channel messages with the channel kind, never the im kind", async () => {
    for (const channelType of ["channel", "group"] as const) {
      const channelMessage = createApp();
      const eventId = `EvChannel-${channelType}`;
      const channelBody = JSON.stringify(messagePayload(eventId, {
        channel_type: channelType,
        channel: "C123",
        thread_ts: "1718800000.000050",
      }));
      const channelResponse = await request(channelMessage.app)
        .post("/api/connectors/slack/events")
        .set(createSignedHeaders(channelBody))
        .type("application/json")
        .send(channelBody);
      expect(channelResponse.status).toBe(200);
      expect(channelMessage.persistence.enqueuedJobs[0]).toMatchObject({
        payload: {
          eventId,
          inbound: { kind: "channel", event: expect.objectContaining({ channel_type: channelType }) },
        },
      });
    }

    const dm = createApp();
    const dmBody = JSON.stringify(messagePayload("EvDm"));
    await request(dm.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(dmBody))
      .type("application/json")
      .send(dmBody);
    expect(dm.persistence.enqueuedJobs[0]).toMatchObject({ payload: { inbound: { kind: "im" } } });
  });

  it("skips channel message subtypes such as edits, deletions, joins, and bot posts", async () => {
    for (const subtype of ["message_changed", "message_deleted", "channel_join", "bot_message", "thread_broadcast"]) {
      const { app, persistence } = createApp();
      const eventId = `EvSubtype-${subtype}`;
      const body = JSON.stringify(messagePayload(eventId, { channel_type: "channel", channel: "C123", subtype }));
      const response = await request(app)
        .post("/api/connectors/slack/events")
        .set(createSignedHeaders(body))
        .type("application/json")
        .send(body);
      expect(response.status).toBe(200);
      expect(persistence.statusByEventId.get(eventId)).toBe("skipped");
      expect(persistence.enqueuedJobs).toHaveLength(0);
    }
  });

  it("accepts a question posted with an attachment (file_share) in channels and direct messages", async () => {
    const channel = createApp();
    const channelBody = JSON.stringify(messagePayload("EvFileChannel", {
      channel_type: "channel",
      channel: "C123",
      subtype: "file_share",
    }));
    await request(channel.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(channelBody))
      .type("application/json")
      .send(channelBody);
    expect(channel.persistence.enqueuedJobs[0]).toMatchObject({
      payload: { eventId: "EvFileChannel", inbound: { kind: "channel", event: expect.objectContaining({ text: "Question" }) } },
    });

    const dm = createApp();
    const dmBody = JSON.stringify(messagePayload("EvFileDm", { subtype: "file_share" }));
    await request(dm.app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(dmBody))
      .type("application/json")
      .send(dmBody);
    expect(dm.persistence.enqueuedJobs[0]).toMatchObject({
      payload: { eventId: "EvFileDm", inbound: { kind: "im", event: expect.objectContaining({ text: "Question" }) } },
    });
  });

  it("skips direct message subtypes such as edits, joins, and bot posts", async () => {
    for (const subtype of ["message_changed", "bot_message", "channel_join"]) {
      const { app, persistence } = createApp();
      const eventId = `EvDmSubtype-${subtype}`;
      const body = JSON.stringify(messagePayload(eventId, { subtype }));
      const response = await request(app)
        .post("/api/connectors/slack/events")
        .set(createSignedHeaders(body))
        .type("application/json")
        .send(body);
      expect(response.status).toBe(200);
      expect(persistence.statusByEventId.get(eventId)).toBe("skipped");
      expect(persistence.enqueuedJobs).toHaveLength(0);
    }
  });

  it("keeps the session thread on direct messages and carries it into the job payload", async () => {
    const { app, persistence } = createApp();
    const body = JSON.stringify(messagePayload("EvSession", { thread_ts: "1718800000.000050" }));
    const response = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body))
      .type("application/json")
      .send(body);
    expect(response.status).toBe(200);
    expect(persistence.enqueuedJobs[0]).toMatchObject({
      payload: {
        eventId: "EvSession",
        inbound: { kind: "im", event: expect.objectContaining({ thread_ts: "1718800000.000050" }) },
      },
    });
  });

  it("dispatches app_home_opened with its tab into the job payload", async () => {
    for (const tab of ["messages", "home"] as const) {
      const { app, persistence } = createApp();
      const eventId = `EvHome-${tab}`;
      const body = JSON.stringify({
        token: "ignored",
        type: "event_callback",
        team_id: "TTEST",
        event_id: eventId,
        event: { type: "app_home_opened", user: "UUSER", channel: "DUSER", tab, event_ts: "1718800000.000300" },
      });
      const response = await request(app)
        .post("/api/connectors/slack/events")
        .set(createSignedHeaders(body))
        .type("application/json")
        .send(body);
      expect(response.status).toBe(200);
      expect(persistence.enqueuedJobs[0]).toMatchObject({
        payload: { eventId, inbound: { kind: "app_home_opened", event: { type: "app_home_opened", user: "UUSER", channel: "DUSER", tab } } },
      });
    }
  });

  it("skips channel messages without a timestamp", async () => {
    const { app, persistence } = createApp();
    const body = JSON.stringify(messagePayload("EvNoTs", { channel_type: "channel", channel: "C123", ts: undefined }));
    const response = await request(app)
      .post("/api/connectors/slack/events")
      .set(createSignedHeaders(body))
      .type("application/json")
      .send(body);
    expect(response.status).toBe(200);
    expect(persistence.statusByEventId.get("EvNoTs")).toBe("skipped");
    expect(persistence.enqueuedJobs).toHaveLength(0);
  });
});
