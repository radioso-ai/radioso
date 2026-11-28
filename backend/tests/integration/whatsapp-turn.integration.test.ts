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
/** The digits every way of writing these numbers shares, with or without a prefix. */
const DIGITS = ["5550100101", "5550100102", "5550100103", "5550100104", "5550100109"];
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
    await plugin.initialize({
      db: database,
      logger,
      chat: composeConnectorChatPort(
        { chatService: conversation.chat, metricsRegistry: harness.metrics } as unknown as Parameters<typeof composeConnectorChatPort>[0],
        plugin.id,
      ),
      state: { getConfig: async () => ({ enabled: true, config: { phone_number_id: PHONE_NUMBER_ID, access_token: "access-token-example", app_secret: APP_SECRET } }) },
      http: { mount: (path: string, router: express.Router) => void app.use(path, router) },
      publicHttp: { fetch: graph },
      metricsRegistry: harness.metrics,
    } as unknown as ConnectorContext);
  });

  afterAll(async () => {
    await plugin.shutdown();
    await shutdownTracing();
    await harness.cleanup();
    await database.close().catch(() => undefined);
  });

  const deliver = async (value: Record<string, unknown>) => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, ...value } }] }],
    });
    await request(app)
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

  /** Delivers `text` from `from` and waits until the channel has dealt with it. */
  const message = async (from: string, text: string, until: string = "replied") => {
    const wamid = `wamid.${randomUUID()}`;
    await deliver({
      contacts: [{ wa_id: from, profile: { name: "Ada Example" } }],
      messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
    });
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

  const storedTurn = async (number: string) => {
    const conversations = (await conversationsOf(number)).map((row) => row.conversation_id);
    const messages = await database.query<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE conversation_id = ANY($1::uuid[]) ORDER BY created_at, id",
      [conversations],
    );
    return { conversations, messages };
  };

  it("keeps one conversation and one stored message when a first message the model failed is redelivered, and answers it once when a retry succeeds", async () => {
    refundFailures = 2;
    const wamid = `wamid.${randomUUID()}`;
    const redelivery = {
      contacts: [{ wa_id: RETRIED_THEN_ANSWERED, profile: { name: "Ada Example" } }],
      messages: [{ id: wamid, from: RETRIED_THEN_ANSWERED, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Can I get a refund?" } }],
    };
    await deliver(redelivery);
    await deliver(redelivery);
    await vi.waitFor(async () => expect(await statusOf(wamid)).toBe("replied"), { timeout: 15_000, interval: 25 });
    await deliver(redelivery);

    const { conversations, messages } = await storedTurn(RETRIED_THEN_ANSWERED);
    expect(conversations).toHaveLength(1);
    expect(messages.map((stored) => stored.role)).toEqual(["user", "assistant"]);
    expect(sent.filter((reply) => reply.to === RETRIED_THEN_ANSWERED)).toHaveLength(1);
  });

  it("continues the conversation of a first message that failed when the sender writes again", async () => {
    await message(FAILED_THEN_ASKS_AGAIN, "What is on my bill?", "failed");
    await message(FAILED_THEN_ASKS_AGAIN, "Are you open on Sundays?");

    const { conversations, messages } = await storedTurn(FAILED_THEN_ASKS_AGAIN);
    expect(conversations).toHaveLength(1);
    expect(messages.filter((stored) => stored.content === "What is on my bill?")).toHaveLength(1);
    expect(messages.map((stored) => stored.role)).toEqual(["user", "user", "assistant"]);
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
    }
  });
});
