import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";

import type { ConnectorContext } from "@radioso/connector-api";
import express, { type Router } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { EmailPlugin } from "../../src/modules/connectors/plugins/email/emailPlugin.js";
import { createEmailWebhookRouter } from "../../src/modules/connectors/plugins/email/emailWebhook.js";
import { LocalInboundEmailReceiver } from "../../src/modules/mail/adapters/localInboundReceiver.js";
import { InMemoryEmailInbound } from "../support/inMemoryEmailChannel.js";

const SECRET = "whsec_bG9jYWwtZGV2LXNlY3JldC0wMDAwMDAwMDAwMDA=";
const STRANGER_SECRET = `whsec_${Buffer.from("somebody-else-entirely-000000").toString("base64")}`;
const NOW = new Date("2026-10-03T13:32:30.000Z");
const SUBJECT = "Question about my account";
const EMAIL_ID = "local-0001";

const signatureFor = (secret: string, id: string, timestamp: number, body: Buffer): string => {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64")}`;
};

const signedHeaders = (body: Buffer, options: { id?: string; secret?: string; at?: Date } = {}) => {
  const id = options.id ?? "msg_0001";
  const timestamp = Math.floor((options.at ?? NOW).getTime() / 1000);
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": signatureFor(options.secret ?? SECRET, id, timestamp, body),
  };
};

const receivedBody = (emailId = EMAIL_ID): Buffer =>
  Buffer.from(JSON.stringify({
    type: "email.received",
    created_at: "2026-10-03T13:32:29.870Z",
    data: {
      email_id: emailId,
      created_at: "2026-10-03T13:32:29.870Z",
      from: "alice@example.test",
      to: ["support@customer.test"],
      cc: [],
      received_for: ["QZ2K7XN4VTM3RLHJWPC6YGBSFD@in.relay.test"],
      message_id: "<msg-0001@example.test>",
      subject: SUBJECT,
    },
  }));

const withRawBody = (app: express.Express) => {
  app.use((req, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
      next();
    });
  });
};

const harness = (options: { insertFails?: boolean } = {}) => {
  const events = new InMemoryEmailInbound(() => NOW);
  if (options.insertFails) {
    vi.spyOn(events, "insertEvent").mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { name: "DatabaseError" }));
  }
  const receiver = new LocalInboundEmailReceiver({ spoolDir: tmpdir(), signingSecrets: { current: SECRET, previous: null } });
  const fetchMessage = vi.spyOn(receiver, "fetchMessage");
  const requestDrain = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
  const app = express();
  withRawBody(app);
  app.use("/api/connectors/email", createEmailWebhookRouter({
    receiver,
    events,
    drains: { requestDrain },
    metrics,
    logger,
    clock: () => NOW,
  }));
  const post = (body: Buffer, headers: Record<string, string>) =>
    request(app).post("/api/connectors/email/webhook").set(headers).send(body.toString("utf8"));
  const results = () => metrics.incrementCounter.mock.calls
    .filter(([name]) => name === "email_webhook_requests_total")
    .map(([, write]) => (write as { labels: Record<string, string> }).labels.result);
  const logged = () => JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
  return { app, events, fetchMessage, requestDrain, logger, post, results, logged };
};

describe("POST /api/connectors/email/webhook", () => {
  it("persists a verified event, acknowledges 200 and pushes an inbound drain", async () => {
    const h = harness();
    const body = receivedBody();

    const response = await h.post(body, signedHeaders(body));

    expect(response.status).toBe(200);
    const stored = [...h.events.events.values()];
    expect(stored).toEqual([expect.objectContaining({
      provider: "local",
      providerEventId: "msg_0001",
      eventKind: "message_received",
      providerObjectId: EMAIL_ID,
      state: "pending",
      envelope: expect.objectContaining({ receivedFor: ["QZ2K7XN4VTM3RLHJWPC6YGBSFD@in.relay.test"] }),
    })]);
    expect(h.requestDrain).toHaveBeenCalledWith(expect.objectContaining({ stage: "inbound" }));
    expect(h.results()).toEqual(["persisted"]);
  });

  it("acknowledges a redelivered svix-id with 200 and writes no row", async () => {
    const h = harness();
    const body = receivedBody();

    await h.post(body, signedHeaders(body));
    const again = await h.post(body, signedHeaders(body));

    expect(again.status).toBe(200);
    expect(h.events.events.size).toBe(1);
    expect(h.requestDrain).toHaveBeenCalledOnce();
    expect(h.results()).toEqual(["persisted", "duplicate"]);
  });

  it("acknowledges a replay with a new svix-id and the same email_id, and writes no row", async () => {
    const h = harness();
    const body = receivedBody();

    await h.post(body, signedHeaders(body, { id: "msg_0001" }));
    const replay = await h.post(body, signedHeaders(body, { id: "msg_replay_0002" }));

    expect(replay.status).toBe(200);
    expect(h.events.events.size).toBe(1);
  });

  it.each([
    ["a bad signature", { secret: STRANGER_SECRET }, "bad_signature"],
    ["a stale timestamp", { at: new Date(NOW.getTime() - 10 * 60 * 1000) }, "stale_timestamp"],
  ])("rejects %s with 401 and never logs the body", async (_label, options, result) => {
    const h = harness();
    const body = receivedBody();

    const response = await h.post(body, signedHeaders(body, options));

    expect(response.status).toBe(401);
    expect(h.events.events.size).toBe(0);
    expect(h.results()).toEqual([result]);
    expect(h.logger.warn).toHaveBeenCalled();
    expect(h.logged()).not.toContain(SUBJECT);
    expect(h.logged()).not.toContain(EMAIL_ID);
    expect(h.logged()).not.toContain("alice@example.test");
  });

  it("rejects a request with no signature with 401", async () => {
    const h = harness();

    const response = await h.post(receivedBody(), { "content-type": "application/json" });

    expect(response.status).toBe(401);
    expect(h.events.events.size).toBe(0);
  });

  it.each([
    ["a body that is not JSON", Buffer.from("{ not json")],
    ["a received event without its email id", Buffer.from(JSON.stringify({ type: "email.received", created_at: NOW.toISOString(), data: {} }))],
  ])("rejects %s with 400", async (_label, body) => {
    const h = harness();

    const response = await h.post(body, signedHeaders(body));

    expect(response.status).toBe(400);
    expect(h.events.events.size).toBe(0);
    expect(h.results()).toEqual(["malformed"]);
  });

  it("answers 503 while the database is unavailable, so the provider retries", async () => {
    const h = harness({ insertFails: true });
    const body = receivedBody();

    const response = await h.post(body, signedHeaders(body));

    expect(response.status).toBe(503);
    expect(h.requestDrain).not.toHaveBeenCalled();
    expect(h.results()).toEqual(["db_unavailable"]);
    expect(h.logged()).not.toContain(SUBJECT);
  });

  it("does nothing inline beyond verify, persist and enqueue", async () => {
    const h = harness();
    const body = receivedBody();

    await h.post(body, signedHeaders(body));

    expect(h.fetchMessage).not.toHaveBeenCalled();
    expect([...h.events.events.values()].every((event) => event.state === "pending" && event.attempts === 0)).toBe(true);
    expect(h.events.deliveries.size).toBe(0);
  });

  it("persists an event type it does not know as unsupported, and acknowledges it", async () => {
    const h = harness();
    const body = Buffer.from(JSON.stringify({ type: "contact.created", created_at: NOW.toISOString(), data: { id: "c_1" } }));

    const response = await h.post(body, signedHeaders(body));

    expect(response.status).toBe(200);
    expect([...h.events.events.values()]).toEqual([expect.objectContaining({
      eventKind: "unsupported",
      providerObjectId: null,
      envelope: { providerType: "contact.created" },
    })]);
  });

  it("acknowledges locally in under a second", async () => {
    const h = harness();
    const body = receivedBody();

    const startedAt = performance.now();
    const response = await h.post(body, signedHeaders(body));

    expect(response.status).toBe(200);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it("acknowledges even when the drain push fails, because the event is already durable", async () => {
    const h = harness();
    h.requestDrain.mockRejectedValueOnce(new Error("queue unavailable"));
    const body = receivedBody();

    const response = await h.post(body, signedHeaders(body));

    expect(response.status).toBe(200);
    expect(h.events.events.size).toBe(1);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.anything(), "email_channel_drain_push_failed");
  });

  it("refuses a request whose raw body was not captured", async () => {
    const events = new InMemoryEmailInbound(() => NOW);
    const app = express();
    app.use(express.json());
    app.use("/api/connectors/email", createEmailWebhookRouter({
      receiver: new LocalInboundEmailReceiver({ spoolDir: tmpdir(), signingSecrets: { current: SECRET, previous: null } }),
      events,
      drains: { requestDrain: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      clock: () => NOW,
    }));
    const body = receivedBody();

    const response = await request(app).post("/api/connectors/email/webhook").set(signedHeaders(body)).send(body.toString("utf8"));

    expect(response.status).toBe(400);
    expect(events.events.size).toBe(0);
  });
});

describe("EmailPlugin", () => {
  it("mounts the webhook at the connector's root and names its path", async () => {
    const mounted: { path: string; router: Router }[] = [];
    const events = new InMemoryEmailInbound(() => NOW);
    const plugin = new EmailPlugin({
      receiver: new LocalInboundEmailReceiver({ spoolDir: tmpdir(), signingSecrets: { current: SECRET, previous: null } }),
      events,
      drains: { requestDrain: vi.fn(async () => undefined) },
      metrics: null,
      clock: () => NOW,
    });

    await plugin.initialize({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      http: { mount: (path: string, router: Router) => mounted.push({ path, router }) },
    } as unknown as ConnectorContext);
    await plugin.initialize({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      http: { mount: (path: string, router: Router) => mounted.push({ path, router }) },
    } as unknown as ConnectorContext);

    expect(plugin.id).toBe("email");
    expect(plugin.getWebhookPath()).toBe("/api/connectors/email/webhook");
    expect(mounted.map((entry) => entry.path)).toEqual(["/"]);
    const app = express();
    withRawBody(app);
    app.use("/api/connectors/email", mounted[0].router);
    const body = receivedBody();
    const response = await request(app).post("/api/connectors/email/webhook").set(signedHeaders(body)).send(body.toString("utf8"));
    expect(response.status).toBe(200);
    expect(events.events.size).toBe(1);
  });
});
