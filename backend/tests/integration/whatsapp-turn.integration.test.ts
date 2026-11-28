import { createHmac, randomUUID } from "node:crypto";

import type { ConnectorContext } from "@radioso/connector-api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { composeConnectorChatPort } from "../../src/app/composition/connectorChat.js";
import { createHttpTracingMiddleware } from "../../src/app/http/middleware/tracingMiddleware.js";
import { captureRequestBody } from "../../src/app/server/createApp.js";
import { ContextVariableValueEraser } from "../../src/db/repositories/contextVariableRepository.js";
import { WhatsAppPlugin } from "../../src/modules/connectors/plugins/whatsapp/whatsappPlugin.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { Database } from "../../src/shared/infra/database.js";
import { createHttpLogger, createLogger } from "../../src/shared/observability/logger.js";
import { initializeTracing, shutdownTracing } from "../../src/shared/observability/tracing/index.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";
import { classBooking, createRoutineConsentChatHarness } from "./support/routineConsentChatHarness.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// Obviously fake numbers in the reserved 555-01xx range, in the form Meta reports `wa_id`.
const NUMBER = "15550100101";
/** A sender id that is no number the host can read: the turn runs without a person. */
const UNREADABLE_NUMBER = "015550100102";
/** Senders with no conversation yet: one whose first turn is answered, one whose first turn fails. */
const FIRST_ANSWERED = "15550100103";
const FIRST_FAILED = "15550100104";
/** Senders whose first turn the model fails: one whose retry then succeeds, one who writes again instead. */
const RETRIED_THEN_ANSWERED = "15550100105";
const FAILED_THEN_ASKS_AGAIN = "15550100106";
const WRITES_WHILE_RETRYING = "15550100107";
const RESTARTED_BETWEEN_ATTEMPTS = "15550100108";
const TIMED_OUT_THEN_FAILED = "15550100110";
/** The digits every way of writing these numbers shares, with or without a prefix. */
const DIGITS = ["5550100101", "5550100102", "5550100103", "5550100104", "5550100105", "5550100106", "5550100107", "5550100108", "5550100109", "5550100110"];
const PHONE_NUMBER_ID = "phone-number-1";
const APP_SECRET = "app-secret-example";
const ROUTINE_ID = "routine-class-observed";

class RecordingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    this.spans.push(...spans);
    callback({ code: 0 });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Runs before each model call, so a test can read what the turn has stored by then. */
let beforeModelCall: (() => Promise<void>) | null = null;

/** The model the booking runs on; asked about the bill, its provider fails with the sender's number in the message. */
/** How many more times the model fails a question about a refund before it answers one. */
let refundFailures = 0;

const model: ChatGateway = {
  async answer(input) {
    await beforeModelCall?.();
    if (input.query.includes("refund") && refundFailures > 0) {
      refundFailures -= 1;
      throw new Error("The provider refused the request");
    }
    if (input.query.includes("bill")) throw new Error(`The provider refused the request for +${NUMBER}`);
    const prompt = input.systemPrompt ?? "";
    if (prompt.includes("wants to start any registered routine")) {
      return JSON.stringify({ matches: [{ routineId: ROUTINE_ID, confidence: 0.95, variables: {} }] });
    }
    if (prompt.includes("claimsAuthority") || prompt.includes("Declared slots")) {
      return JSON.stringify({ variables: input.query === "My name is Ada" ? { name: "Ada" } : {}, claimsAuthority: false, condition: null, offTopic: false });
    }
    return `[step reply to: ${input.query}]`;
  },
  async *streamAnswer() {
    throw new Error("these turns run the non-streaming path");
  },
};

/** A booking that asks for a name and keeps it under the person it is with. */
const booking = {
  ...classBooking("continue"),
  id: ROUTINE_ID,
  lineageId: ROUTINE_ID,
  consents: [],
  slots: [{ stableSlotId: "slot_name", key: "name", type: "text" as const, required: true, description: "The visitor's name", ordinal: 0, saveTo: { contextVariable: "visitor_name", scope: "person" as const } }],
  steps: [{ stableStepId: "ask_name", kind: "chat" as const, instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask_name", toRef: "done", guardKind: "default" as const, guardText: null, ordinal: 0 }],
};

/**
 * Real WhatsApp turns from Meta's webhook to the stored reply, on the production plugin, chat port,
 * chat service and turn persistence. The sender's number is a person key (#1884) and a phone number.
 */
describeIntegration("a WhatsApp turn from Meta's webhook (Postgres, #1884)", () => {
  const database = new Database(integrationDatabaseUrl);
  const logLines: string[] = [];
  const logger = createLogger("trace", { write: (line: string) => void logLines.push(line) });
  const harness = createRoutineConsentChatHarness(database, model, { logger });
  const spans = new RecordingExporter();
  const sent: Array<{ to: string; text: string }> = [];
  /** What Meta's Graph API answers a send with, once; a refusal names the number it would not deliver to. */
  let refusal: { status: number; body: unknown } | null = null;
  const graph = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (refusal) {
      const { status, body } = refusal;
      refusal = null;
      return Response.json(body, { status });
    }
    const message = JSON.parse(init?.body as string) as { to?: string; text?: { body?: string } };
    sent.push({ to: message.to ?? "", text: message.text?.body ?? "" });
    return Response.json({ messages: [{ id: `wamid.out-${randomUUID()}` }] });
  });
  const plugin = new WhatsAppPlugin({
    fetch: graph as unknown as typeof fetch,
    sleep: async () => undefined,
    debounceMs: 0,
    personValues: (db) => new ContextVariableValueEraser(db),
  });
  const app = express();
  let workspaceId: string;
  let chatService: unknown;
  /** The conversation timeout the connector is configured with, in hours; a test sets a few seconds' worth. */
  let timeoutHours: string | undefined;
  /** Every message id a test delivered: Meta's encode the sender's number, so none may reach an output. */
  const deliveredWamids: string[] = [];

  beforeAll(async () => {
    await runAllTestMigrations(database);
    initializeTracing({
      enabled: true,
      environment: "test",
      otlpEndpoint: "http://localhost:4318/v1/traces",
      runtimeRole: "api",
      serviceName: "radioso-api",
      spanExporter: spans,
    });
    const conversation = await harness.startConversation({ definition: booking, backgroundJobs: true });
    workspaceId = conversation.workspaceId;
    chatService = conversation.chat;
    const [variable] = await database.query<{ id: string }>(
      `INSERT INTO context_variables (workspace_id, name, value_type, trust_tier, sensitivity, default_surfacing)
       VALUES ($1, 'visitor_name', 'string', 'unverified', 'normal', 'on_reference') RETURNING id`,
      [workspaceId],
    );
    const now = new Date().toISOString();
    await database.query("UPDATE agent_revisions SET snapshot = $1::jsonb WHERE agent_id = $2", [
      JSON.stringify({ contextVariableEnablements: [{
        id: randomUUID(), agentId: conversation.agentId, variableId: variable.id, source: "pushed", resolverSkillId: null, maxAgeSeconds: null,
        resolverTimeoutMs: null, surfacing: "on_reference", enabled: true, createdAt: now, updatedAt: now,
      }] }),
      conversation.agentId,
    ]);

    app.use(createHttpLogger(logger));
    app.use(createHttpTracingMiddleware());
    app.use(captureRequestBody);
    await startPlugin(plugin, app);
  });

  /** Brings a connector up on `target`, as the host does on a boot. */
  const startPlugin = async (instance: WhatsAppPlugin, target: express.Express) => {
    await instance.initialize({
      db: database,
      logger,
      chat: composeConnectorChatPort(
        { chatService, metricsRegistry: harness.metrics } as unknown as Parameters<typeof composeConnectorChatPort>[0],
        instance.id,
      ),
      state: { getConfig: async () => ({ enabled: true, config: { phone_number_id: PHONE_NUMBER_ID, access_token: "access-token-example", app_secret: APP_SECRET, ...(timeoutHours ? { conversation_timeout_hours: timeoutHours } : {}) } }) },
      http: { mount: (path: string, router: express.Router) => void target.use(path, router) },
      publicHttp: { fetch: graph },
      metricsRegistry: harness.metrics,
    } as unknown as ConnectorContext);
  };

  const newPlugin = (options: { recoveryLeaseMs?: number } = {}) => new WhatsAppPlugin({
    fetch: graph as unknown as typeof fetch,
    sleep: async () => undefined,
    debounceMs: 0,
    personValues: (db) => new ContextVariableValueEraser(db),
    ...options,
  });

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  afterAll(async () => {
    await plugin.shutdown();
    await shutdownTracing();
    await harness.cleanup();
    await database.close().catch(() => undefined);
  });

  const deliver = async (value: Record<string, unknown>, target: express.Express = app) => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, ...value } }] }],
    });
    await request(target)
      .post(`/${workspaceId}/webhook`)
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`)
      .send(body)
      .expect(200);
  };

  const statusOf = async (wamid: string) => (await database.query<{ status: string }>(
    "SELECT status FROM connector_whatsapp_message_log WHERE workspace_id = $1 AND wamid = $2",
    [workspaceId, wamid],
  ))[0]?.status;

  /** A message id shaped like Meta's, which carries the sender's number base64-encoded. */
  const wamidFor = (from: string) => {
    const wamid = `wamid.${Buffer.from(`\u0018\u000b${from}\u0015\u0002\u0000\u0012\u0018\u0014${randomUUID()}`).toString("base64").replace(/=+$/u, "")}`;
    deliveredWamids.push(wamid);
    return wamid;
  };

  const inboundBody = (from: string, wamid: string, text: string) => ({
    contacts: [{ wa_id: from, profile: { name: "Ada Example" } }],
    messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  });

  /** Delivers `text` from `from` and waits until the channel has dealt with it. */
  const message = async (from: string, text: string, until: string = "replied") => {
    const wamid = wamidFor(from);
    await deliver(inboundBody(from, wamid, text));
    await vi.waitFor(async () => expect(await statusOf(wamid)).toBe(until), { timeout: 15_000, interval: 25 });
    return wamid;
  };

  const personValues = () => database.query<{ scope_type: string; scope_id: string; data: unknown }>(
    "SELECT scope_type, scope_id, data FROM context_variable_values WHERE workspace_id = $1",
    [workspaceId],
  );

  const conversationsOf = (number: string) => database.query<{ conversation_id: string }>(
    "SELECT conversation_id FROM connector_whatsapp_conversations WHERE workspace_id = $1 AND wa_id = $2",
    [workspaceId, number],
  );

  it("is recorded with its number before the turn calls a model, so every reader of the new conversation has the person", async () => {
    const duringTurn: number[] = [];
    beforeModelCall = async () => void duringTurn.push((await conversationsOf(FIRST_ANSWERED)).length);

    await message(FIRST_ANSWERED, "I want to book a class").finally(() => { beforeModelCall = null; });

    expect(duringTurn.length).toBeGreaterThan(0);
    expect(new Set(duringTurn)).toEqual(new Set([1]));
    expect(await conversationsOf(FIRST_ANSWERED)).toHaveLength(1);
  });

  it("is recorded with its number when its first turn fails", async () => {
    await message(FIRST_FAILED, "What is on my bill?", "failed");

    const [recorded] = await conversationsOf(FIRST_FAILED);
    expect(recorded).toBeDefined();
    expect(await database.query("SELECT role FROM messages WHERE conversation_id = $1", [recorded.conversation_id])).toEqual([{ role: "user" }]);
  });

  /** What the workspace holds for its WhatsApp channel, read from the host's own tables and not the connector's records. */
  const channelCounts = async (text: string) => {
    const [conversations] = await database.query<{ count: string }>(
      "SELECT count(*) FROM conversations WHERE workspace_id = $1 AND source_channel = 'whatsapp'",
      [workspaceId],
    );
    const [stored] = await database.query<{ count: string }>(
      `SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.workspace_id = $1 AND c.source_channel = 'whatsapp' AND m.role = 'user' AND m.content = $2`,
      [workspaceId, text],
    );
    return { conversations: Number(conversations.count), stored: Number(stored.count) };
  };

  /** The conversations that hold a stored message with this text, and the roles in each, oldest first. */
  const conversationsHolding = async (text: string) => {
    const rows = await database.query<{ conversation_id: string; role: string }>(
      `SELECT m.conversation_id, m.role FROM messages m WHERE m.conversation_id IN (
         SELECT m2.conversation_id FROM messages m2 JOIN conversations c ON c.id = m2.conversation_id
          WHERE c.workspace_id = $1 AND c.source_channel = 'whatsapp' AND m2.content = $2)
        ORDER BY m.created_at, m.id`,
      [workspaceId, text],
    );
    return [...new Set(rows.map((row) => row.conversation_id))].map((id) => ({ id, roles: rows.filter((row) => row.conversation_id === id).map((row) => row.role) }));
  };

  it("answers a first message once, in one conversation, when the connector's retry succeeds after the model failed it twice; Meta's redeliveries are dropped", async () => {
    refundFailures = 2;
    const before = await channelCounts("Can I get a refund?");
    const wamid = wamidFor(RETRIED_THEN_ANSWERED);
    const delivery = inboundBody(RETRIED_THEN_ANSWERED, wamid, "Can I get a refund?");
    await deliver(delivery);
    await deliver(delivery);
    await vi.waitFor(async () => expect(await statusOf(wamid)).toBe("replied"), { timeout: 15_000, interval: 25 });
    await deliver(delivery);

    const after = await channelCounts("Can I get a refund?");
    expect(after.conversations - before.conversations).toBe(1);
    expect(after.stored).toBe(1);
    expect((await conversationsHolding("Can I get a refund?")).map((held) => held.roles)).toEqual([["user", "assistant"]]);
    expect(sent.filter((reply) => reply.to === RETRIED_THEN_ANSWERED)).toHaveLength(1);
  });

  it("continues the conversation of a first message that failed when the sender writes again, storing the failed message once", async () => {
    const before = await channelCounts("What is on my invoice? bill");
    await message(FAILED_THEN_ASKS_AGAIN, "What is on my invoice? bill", "failed");
    await message(FAILED_THEN_ASKS_AGAIN, "Are you open on Mondays?");

    const after = await channelCounts("What is on my invoice? bill");
    expect(after.conversations - before.conversations).toBe(1);
    expect(after.stored).toBe(1);
    expect((await conversationsHolding("What is on my invoice? bill")).map((held) => held.roles)).toEqual([["user", "user", "assistant"]]);
  });

  it("answers the failed message in place, with the sender's newer message already answered in its conversation, when its retry runs", async () => {
    refundFailures = 1;
    const before = await channelCounts("Can I get a refund for the class?");
    const failed = wamidFor(WRITES_WHILE_RETRYING);
    await deliver(inboundBody(WRITES_WHILE_RETRYING, failed, "Can I get a refund for the class?"));
    await vi.waitFor(async () => expect(await statusOf(failed)).toBe("retryable_failed"), { timeout: 15_000, interval: 5 });
    await message(WRITES_WHILE_RETRYING, "Are you open on Tuesdays?");
    await vi.waitFor(async () => expect(await statusOf(failed)).toBe("replied"), { timeout: 15_000, interval: 25 });

    const after = await channelCounts("Can I get a refund for the class?");
    expect(after.conversations - before.conversations).toBe(1);
    expect(after.stored).toBe(1);
    expect((await conversationsHolding("Are you open on Tuesdays?")).map((held) => held.id)).toEqual((await conversationsHolding("Can I get a refund for the class?")).map((held) => held.id));
    expect(sent.filter((reply) => reply.to === WRITES_WHILE_RETRYING)).toHaveLength(2);
  });

  it("answers a stored first message once, in its conversation, when the connector restarts between the failed attempt and the retry", async () => {
    refundFailures = 1;
    const text = "Can I get a refund for my pass?";
    const before = await channelCounts(text);
    const crashedApp = express();
    crashedApp.use(captureRequestBody);
    const crashed = newPlugin();
    await startPlugin(crashed, crashedApp);
    const wamid = wamidFor(RESTARTED_BETWEEN_ATTEMPTS);
    await deliver(inboundBody(RESTARTED_BETWEEN_ATTEMPTS, wamid, text), crashedApp);
    await vi.waitFor(async () => expect(await statusOf(wamid)).toBe("retryable_failed"), { timeout: 15_000, interval: 5 });
    await crashed.shutdown();

    // The message waits out the recovery lease, then the restarted connector claims it.
    await pause(2_100);
    const restarted = newPlugin({ recoveryLeaseMs: 2_000 });
    await startPlugin(restarted, express());
    await vi.waitFor(async () => expect(await statusOf(wamid)).toBe("replied"), { timeout: 15_000, interval: 25 });
    await restarted.shutdown();

    const after = await channelCounts(text);
    expect(after.conversations - before.conversations).toBe(1);
    expect(after.stored).toBe(1);
    expect(sent.filter((reply) => reply.to === RESTARTED_BETWEEN_ATTEMPTS)).toHaveLength(1);
  });

  it("continues the conversation a first message failed in when the sender, answered in an earlier one past the timeout, writes again", async () => {
    timeoutHours = "0.0015";
    try {
      await message(TIMED_OUT_THEN_FAILED, "Are you open on Wednesdays?");
      await pause(7_000);
      await message(TIMED_OUT_THEN_FAILED, "What is on my receipt? bill", "failed");
      await message(TIMED_OUT_THEN_FAILED, "Do you have parking?");
    } finally {
      timeoutHours = undefined;
    }

    const first = await conversationsHolding("Are you open on Wednesdays?");
    const failed = await conversationsHolding("What is on my receipt? bill");
    expect(first).toHaveLength(1);
    expect(failed).toEqual([{ id: expect.any(String), roles: ["user", "user", "assistant"] }]);
    expect(failed[0].id).not.toBe(first[0].id);
    expect((await conversationsHolding("Do you have parking?")).map((held) => held.id)).toEqual([failed[0].id]);
  });

  it("shows its sender's number in no log line, metric, span, event, job or audit record, through a save, a failure and a number change", async () => {
    await message(NUMBER, "I want to book a class");
    await message(NUMBER, "My name is Ada");
    expect(await personValues()).toEqual([{ scope_type: "whatsapp_contact", scope_id: NUMBER, data: "Ada" }]);

    // A sender id the host cannot read: the visitor is answered, with no person.
    await message(UNREADABLE_NUMBER, "Are you open on Sundays?");
    // A reply Meta refuses, naming the number, and a model that fails naming it.
    refusal = { status: 400, body: { error: { code: 131026, message: `Message undeliverable to +${NUMBER}`, error_data: { details: `Recipient ${NUMBER} is not on WhatsApp` } } } };
    await message(NUMBER, "Where do I park?", "failed");
    await message(NUMBER, "What is on my bill?", "failed");
    // Meta's own reports: a delivery that failed, and the sender's change of number.
    await deliver({ statuses: [{ id: "wamid.out-1", status: "failed", recipient_id: NUMBER, errors: [{ code: 131026, title: `Undeliverable to ${NUMBER}` }] }] });
    await deliver({ messages: [{ id: `wamid.${randomUUID()}`, from: NUMBER, timestamp: "1763632800", type: "system", system: { type: "user_changed_number", wa_id: "15550100109", body: `Ada changed from ${NUMBER}` } }] });
    await vi.waitFor(async () => expect(await personValues()).toEqual([]), { timeout: 15_000, interval: 25 });

    const observed = {
      logs: logLines.join("\n"),
      metrics: harness.metrics.renderPrometheus(),
      spans: JSON.stringify(spans.spans.map(({ name, attributes, events, links, status, resource }) => ({ name, attributes, events, links, status, resource: resource.attributes }))),
      workspaceEvents: JSON.stringify(await database.query("SELECT * FROM workspace_events WHERE workspace_id = $1", [workspaceId])),
      backgroundJobs: JSON.stringify(await database.query("SELECT kind, idempotency_key, payload, last_error FROM background_jobs WHERE payload->>'workspaceId' = $1", [workspaceId])),
      auditEvents: JSON.stringify(await database.query("SELECT * FROM audit_events WHERE workspace_id = $1", [workspaceId])),
    };
    // Each channel saw the turns it is read for, so an empty one cannot pass.
    expect(sent.map((reply) => reply.to)).toContain(NUMBER);
    expect(observed.logs).toContain("request completed");
    expect(observed.metrics).toMatch(/connector_person_keys_unused_total\{[^}]*reason="unreadable"[^}]*\} 1/u);
    expect(observed.metrics).toMatch(/context_value_writes_total\{[^}]*outcome="written"[^}]*\} 1/u);
    expect(observed.metrics).toMatch(/whatsapp_number_changes_total\{[^}]*outcome="forgotten"[^}]*\} 1/u);
    expect(spans.spans.length).toBeGreaterThan(0);
    for (const record of [observed.workspaceEvents, observed.backgroundJobs, observed.auditEvents]) expect(record).not.toBe("[]");
    for (const [channel, output] of Object.entries(observed)) {
      for (const digits of DIGITS) expect(output.includes(digits), `the number in ${channel}`).toBe(false);
      for (const wamid of deliveredWamids) expect(output.includes(wamid), `a message id, which encodes the number, in ${channel}`).toBe(false);
    }
  });
});
