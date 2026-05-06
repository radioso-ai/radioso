import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { UsageLimitDatabaseClient, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { EnterpriseHumanContactService } from "./humanContactService.js";

type RequestRow = {
  id: string;
  account_id: string | null;
  workspace_id: string;
  conversation_id: string;
  assistant_message_id: string | null;
  source_channel: string | null;
  source_origin: string | null;
  user_email: string;
  message: string;
  generated_summary: string;
  trigger_source: string;
  trigger_reason: string | null;
  attempts: number;
  status: "pending" | "delivering" | "delivered" | "failed";
  next_retry_at: Date;
  created_at: Date;
  final_delivery_error?: string | null;
};

class FakeHumanContactDatabase implements UsageLimitDatabasePort {
  readonly settings = new Map<string, {
    workspace_id: string;
    enabled: boolean;
    email_enabled: boolean;
    default_email: string | null;
    webhook_enabled: boolean;
    webhook_url: string | null;
    signing_secret: string | null;
    updated_at: Date;
  }>();
  readonly requests = new Map<string, RequestRow>();

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    if (text.includes("FROM ee_contact_settings") && text.includes("SELECT")) {
      const row = this.settings.get(String(params[0]));
      return (row ? [row] : []) as T[];
    }

    if (text.includes("INSERT INTO ee_contact_settings")) {
      const row = {
        workspace_id: String(params[0]),
        enabled: Boolean(params[1]),
        email_enabled: Boolean(params[2]),
        default_email: params[3] === null ? null : String(params[3]),
        webhook_enabled: Boolean(params[4]),
        webhook_url: params[5] === null ? null : String(params[5]),
        signing_secret: params[6] === null ? null : String(params[6]),
        updated_at: new Date("2026-05-04T10:00:00.000Z"),
      };
      this.settings.set(row.workspace_id, row);
      return [row] as T[];
    }

    if (text.includes("INSERT INTO ee_contact_requests")) {
      const row: RequestRow = {
        id: String(params[0]),
        account_id: params[1] === null ? null : String(params[1]),
        workspace_id: String(params[2]),
        conversation_id: String(params[3]),
        assistant_message_id: params[4] === null ? null : String(params[4]),
        source_channel: params[5] === null ? null : String(params[5]),
        source_origin: params[6] === null ? null : String(params[6]),
        user_email: String(params[7]),
        message: String(params[8]),
        generated_summary: String(params[9]),
        trigger_source: String(params[10]),
        trigger_reason: params[11] === null ? null : String(params[11]),
        status: "pending",
        attempts: 0,
        next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
        created_at: new Date("2026-05-04T10:00:00.000Z"),
      };
      this.requests.set(row.id, row);
      return [] as T[];
    }

    if (text.includes("UPDATE ee_contact_requests") && text.includes("status = 'delivering'")) {
      const maxAttempts = Number(params[0]);
      const limit = Number(params[1]);
      const dueRows = [...this.requests.values()]
        .filter((row) => row.status === "pending" && row.attempts < maxAttempts)
        .slice(0, limit);
      for (const row of dueRows) {
        row.status = "delivering";
      }
      return dueRows as T[];
    }

    if (text.includes("SET status = 'delivered'")) {
      const row = this.requests.get(String(params[0]));
      if (row) {
        row.status = "delivered";
        row.attempts += 1;
        row.final_delivery_error = null;
      }
      return [] as T[];
    }

    if (text.includes("SET status = $2")) {
      const row = this.requests.get(String(params[0]));
      if (row) {
        row.status = String(params[1]) as RequestRow["status"];
        row.attempts += 1;
        row.final_delivery_error = String(params[3]);
      }
      return [] as T[];
    }

    return [] as T[];
  }

  async withTransaction<T>(callback: (client: UsageLimitDatabaseClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const createService = (input: {
  database?: FakeHumanContactDatabase;
  webhookFetch?: typeof fetch;
  chatGateway?: unknown;
} = {}) => {
  const database = input.database ?? new FakeHumanContactDatabase();
  const auditEvents: unknown[] = [];
  const sentEmails: unknown[] = [];
  const service = new EnterpriseHumanContactService({
    database,
    logger: { error: () => undefined, warn: () => undefined },
    conversationRepository: {
      async findByIdAndWorkspaceId(conversationId, workspaceId) {
        return { id: conversationId, workspaceId, sourceChannel: "authenticated_chat", sourceOrigin: null, anonymousSessionId: null };
      },
      async findByIdAndAnonymousSession(conversationId, workspaceId, anonymousSessionId) {
        return { id: conversationId, workspaceId, sourceChannel: "website_embed", sourceOrigin: null, anonymousSessionId };
      },
    },
    messageRepository: {
      async listRecentByConversationId() {
        return [
          {
            id: "message-1",
            role: "user",
            content: "I need help with billing.",
            createdAt: new Date("2026-05-04T10:00:00.000Z"),
          },
          {
            id: "message-2",
            role: "assistant",
            content: "I could not find that in the indexed documents.",
            createdAt: new Date("2026-05-04T10:01:00.000Z"),
          },
        ];
      },
    },
    auditService: {
      async record(event) {
        auditEvents.push(event);
      },
    },
    abuseControlService: {
      async enforce() {
        return undefined;
      },
    },
    emailService: {
      async send(message) {
        sentEmails.push(message);
        return undefined;
      },
    },
    chatGateway: input.chatGateway,
    webhookFetch: input.webhookFetch,
    startPoller: false,
  });

  return { service, database, auditEvents, sentEmails };
};

describe("enterprise human contact service", () => {
  it("saves settings and never returns the signing token in settings readback", async () => {
    const { service, database } = createService();

    const settings = await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      webhookEnabled: true,
      webhookUrl: "https://hooks.example.com/radioso",
      signingSecret: "secret-value-for-tests",
    });

    expect(settings).toEqual({
      enabled: true,
      emailEnabled: false,
      defaultEmail: null,
      webhookEnabled: true,
      configured: true,
      webhookUrl: "https://hooks.example.com/radioso",
      signingSecretConfigured: true,
      updatedAt: "2026-05-04T10:00:00.000Z",
    });
    expect(settings).not.toHaveProperty("signingSecret");

    const originalSecret = database.settings.get("workspace-1")?.signing_secret;
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      webhookEnabled: true,
      rotateSigningSecret: true,
    });

    expect(database.settings.get("workspace-1")?.signing_secret).toEqual(expect.any(String));
    expect(database.settings.get("workspace-1")?.signing_secret).not.toBe(originalSecret);
  });

  it("delivers requests by email when email delivery is configured", async () => {
    const database = new FakeHumanContactDatabase();
    const { service, sentEmails } = createService({ database });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    database.requests.set("request-1", {
      id: "request-1",
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      source_channel: "authenticated_chat",
      source_origin: null,
      user_email: "user@example.com",
      message: "Please contact me.",
      generated_summary: "The user wants human follow-up.",
      trigger_source: "manual",
      trigger_reason: null,
      attempts: 0,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      created_at: new Date("2026-05-04T10:00:00.000Z"),
    });

    await service.processDueDeliveries(1);

    expect(sentEmails).toEqual([
      expect.objectContaining({
        to: "support@example.com",
        subject: expect.stringContaining("user@example.com"),
        text: expect.stringContaining("Please contact me."),
      }),
    ]);
    expect(database.requests.get("request-1")?.status).toBe("delivered");
  });

  it("creates a contact suggestion for deterministic grounded failure triggers", async () => {
    let answerCalls = 0;
    const { service } = createService({
      chatGateway: {
        async answer() {
          answerCalls += 1;
          return "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const suggestion = await service.evaluateChatAction({
      workspaceId: "workspace-1",
      assistantMessageId: "assistant-message-1",
      query: "What is my refund status?",
      answer: "I could not find enough context.",
      answerOutcome: "no_context_refusal",
    });

    expect(suggestion).toMatchObject({
      text: "Talk to a human",
      kind: "contact_human",
      action: {
        kind: "contact_human",
        payload: {
          triggerSource: "no_context_refusal",
          assistantMessageId: "assistant-message-1",
        },
      },
    });
  });

  it("returns an editable draft without generating a summary", async () => {
    let answerCalls = 0;
    const { service } = createService({
      chatGateway: {
        async answer() {
          answerCalls += 1;
          return "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      webhookEnabled: true,
      webhookUrl: "https://hooks.example.com/radioso",
      signingSecret: "secret-value-for-tests",
    });

    const draft = await service.draft({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      defaultEmail: "user@example.com",
    });

    expect(draft.draftMessage).toContain("I need help with billing.");
    expect(draft).not.toHaveProperty("summary");
    expect(answerCalls).toBe(0);
  });

  it("stores submitted messages without generating summaries", async () => {
    const { service, database } = createService();
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.submit({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      email: "user@example.com",
      message: "Please contact me.",
      triggerSource: "manual",
    });

    expect(database.requests.get(result.requestId)).toMatchObject({
      message: "Please contact me.",
      generated_summary: "",
    });
  });

  it("signs webhook deliveries and marks successful requests delivered", async () => {
    const database = new FakeHumanContactDatabase();
    let deliveredBody = "";
    let deliveredSignature = "";
    const { service } = createService({
      database,
      webhookFetch: (async (_url, init) => {
        deliveredBody = String(init?.body);
        deliveredSignature = String(new Headers(init?.headers).get("x-radioso-signature"));
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      webhookEnabled: true,
      webhookUrl: "https://hooks.example.com/radioso",
      signingSecret: "secret-value-for-tests",
    });

    const requestId = "request-1";
    database.requests.set(requestId, {
      id: requestId,
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      source_channel: "authenticated_chat",
      source_origin: null,
      user_email: "user@example.com",
      message: "Please contact me.",
      generated_summary: "The user wants human follow-up.",
      trigger_source: "manual",
      trigger_reason: null,
      attempts: 0,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      created_at: new Date("2026-05-04T10:00:00.000Z"),
    });

    await service.processDueDeliveries(1);

    const expectedSignature = createHmac("sha256", "secret-value-for-tests").update(deliveredBody).digest("hex");
    expect(deliveredSignature).toBe(`sha256=${expectedSignature}`);
    const deliveredPayload = JSON.parse(deliveredBody) as Record<string, unknown>;
    expect(deliveredPayload).toMatchObject({
      requestId,
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      email: "user@example.com",
      message: "Please contact me.",
      triggerSource: "manual",
    });
    expect(deliveredPayload).not.toHaveProperty("summary");
    expect(database.requests.get(requestId)?.status).toBe("delivered");
  });

  it("marks webhook deliveries failed after the terminal retry attempt", async () => {
    const database = new FakeHumanContactDatabase();
    const { service } = createService({
      database,
      webhookFetch: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      webhookEnabled: true,
      webhookUrl: "https://hooks.example.com/radioso",
      signingSecret: "secret-value-for-tests",
    });

    database.requests.set("request-1", {
      id: "request-1",
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      source_channel: "authenticated_chat",
      source_origin: null,
      user_email: "user@example.com",
      message: "Please contact me.",
      generated_summary: "The user wants human follow-up.",
      trigger_source: "manual",
      trigger_reason: null,
      attempts: 7,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      created_at: new Date("2026-05-04T10:00:00.000Z"),
    });

    await service.processDueDeliveries(1);

    expect(database.requests.get("request-1")).toMatchObject({
      status: "failed",
      attempts: 8,
      final_delivery_error: "Webhook: HTTP 500",
    });
  });
});
