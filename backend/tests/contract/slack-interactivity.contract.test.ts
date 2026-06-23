import { createHmac } from "node:crypto";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createSlackInteractivityRouter } from "../../src/modules/slack/operator/slackInteractivityRouter.js";

const signingSecret = "test-signing-secret";
const nowMs = Date.parse("2026-06-23T12:00:00.000Z");

const createSignedHeaders = (body: string, timestamp = Math.floor(nowMs / 1000).toString()) => {
  const base = `v0:${timestamp}:${body}`;
  return {
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`,
  };
};

const createApp = () => {
  const app = express();
  app.use((req, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      (req as typeof req & { rawBody?: Buffer }).rawBody = rawBody;
      req.body = Object.fromEntries(new URLSearchParams(rawBody.toString("utf8")));
      next();
    });
  });
  const handler = {
    handleBlockActions: vi.fn(async () => undefined),
    handleViewSubmission: vi.fn(async () => undefined),
    handleViewClosed: vi.fn(async () => undefined),
  };
  app.use("/api/connectors/slack", createSlackInteractivityRouter({
    signingSecret,
    now: () => nowMs,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    handler,
  }));
  return { app, handler };
};

const formBody = (payload: unknown): string =>
  new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

describe("Slack interactivity contract", () => {
  it("verifies the Slack signature, parses urlencoded payload, routes block actions, and fast-acks", async () => {
    const { app, handler } = createApp();
    const payload = {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      actions: [{ action_id: "decision_resolve", value: "{}" }],
    };
    const body = formBody(payload);

    const response = await request(app)
      .post("/api/connectors/slack/interactivity")
      .set(createSignedHeaders(body))
      .type("application/x-www-form-urlencoded")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.text).toBe("OK");
    expect(handler.handleBlockActions).toHaveBeenCalledWith(payload);
  });

  it("routes view submissions and view closed callbacks", async () => {
    const { app, handler } = createApp();
    const submissionBody = formBody({ type: "view_submission", team: { id: "T1" }, user: { id: "U1" } });
    const closedBody = formBody({ type: "view_closed", team: { id: "T1" }, user: { id: "U1" } });

    expect((await request(app)
      .post("/api/connectors/slack/interactivity")
      .set(createSignedHeaders(submissionBody))
      .type("application/x-www-form-urlencoded")
      .send(submissionBody)).status).toBe(200);
    expect((await request(app)
      .post("/api/connectors/slack/interactivity")
      .set(createSignedHeaders(closedBody))
      .type("application/x-www-form-urlencoded")
      .send(closedBody)).status).toBe(200);

    expect(handler.handleViewSubmission).toHaveBeenCalledTimes(1);
    expect(handler.handleViewClosed).toHaveBeenCalledTimes(1);
  });

  it("rejects forged and stale signatures before routing", async () => {
    const { app, handler } = createApp();
    const body = formBody({ type: "block_actions" });

    const forged = await request(app)
      .post("/api/connectors/slack/interactivity")
      .set({ ...createSignedHeaders(body), "X-Slack-Signature": "v0=bad" })
      .type("application/x-www-form-urlencoded")
      .send(body);
    const stale = await request(app)
      .post("/api/connectors/slack/interactivity")
      .set(createSignedHeaders(body, String(Math.floor(nowMs / 1000) - 301)))
      .type("application/x-www-form-urlencoded")
      .send(body);

    expect(forged.status).toBe(401);
    expect(stale.status).toBe(401);
    expect(handler.handleBlockActions).not.toHaveBeenCalled();
  });

  it("rejects malformed callback payloads", async () => {
    const { app, handler } = createApp();
    const body = new URLSearchParams({ payload: "not-json" }).toString();

    const response = await request(app)
      .post("/api/connectors/slack/interactivity")
      .set(createSignedHeaders(body))
      .type("application/x-www-form-urlencoded")
      .send(body);

    expect(response.status).toBe(400);
    expect(handler.handleBlockActions).not.toHaveBeenCalled();
  });
});
