import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { UsageLimitDatabaseClient, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { EnterpriseHumanContactService } from "./humanContactService.js";
import type { MailService } from "./humanContactTypes.js";

type CapturedMail = Parameters<MailService["send"]>[0];
import { humanContactRequestSkillDefinition } from "./skill/definition.js";
import { DefinitionBackedIntakePrompts } from "./skill/definitionBackedIntakePrompts.js";
import { resolveLanguageContext } from "./skill/humanContactIntakeProvider.js";

type SubmissionRow = {
  id: string;
  account_id: string | null;
  workspace_id: string;
  conversation_id: string;
  assistant_message_id: string | null;
  skill_name: string;
  source_channel: string | null;
  source_origin: string | null;
  trigger_source: string;
  trigger_reason: string | null;
  idempotency_key: string | null;
  fields: Record<string, unknown>;
  subject_identity: string | null;
  attempts: number;
  status: "pending" | "delivering" | "delivered" | "failed";
  next_retry_at: Date;
  final_delivery_error: string | null;
  activity_trace: unknown;
  created_at: Date;
  updated_at: Date;
  total_count?: string;
};

type IntakeStateRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  skill_name: string;
  status: "active" | "paused" | "awaiting_confirmation" | "awaiting_tool" | "completed" | "cancelled" | "expired" | "failed";
  collected: Record<string, unknown>;
  invalid: Record<string, unknown>;
  missing: string[];
  expires_at: Date;
  last_prompted_field: string | null;
  created_at: Date;
  updated_at: Date;
};

class FakeSkillSubmissionDatabase implements UsageLimitDatabasePort {
  readonly now = new Date("2026-05-04T10:02:00.000Z");
  failNextSkillIntakeInsert = false;
  failNextSkillIntakeUpdate = false;
  readonly settings = new Map<string, {
    workspace_id: string;
    enabled: boolean;
    email_enabled: boolean;
    default_email: string | null;
    default_emails: string[] | null;
    webhook_enabled: boolean;
    webhook_url: string | null;
    signing_secret: string | null;
    updated_at: Date;
  }>();
  readonly submissions = new Map<string, SubmissionRow>();
  readonly assistantMessages = new Set<string>();
  readonly intakeStates = new Map<string, IntakeStateRow>();

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    if (text.includes("FROM ee_contact_settings") && text.includes("SELECT")) {
      const row = this.settings.get(String(params[0]));
      return (row ? [row] : []) as T[];
    }

    if (text.includes("FROM messages") && text.includes("role = 'assistant'")) {
      const id = String(params[0]);
      return (this.assistantMessages.has(id) ? [{ id }] : []) as T[];
    }

    if (text.includes("INSERT INTO ee_contact_settings")) {
      const row = {
        workspace_id: String(params[0]),
        enabled: Boolean(params[1]),
        email_enabled: Boolean(params[2]),
        default_email: params[3] === null ? null : String(params[3]),
        default_emails: Array.isArray(params[4]) ? params[4] as string[] : null,
        webhook_enabled: Boolean(params[5]),
        webhook_url: params[6] === null ? null : String(params[6]),
        signing_secret: params[7] === null ? null : String(params[7]),
        updated_at: new Date("2026-05-04T10:00:00.000Z"),
      };
      this.settings.set(row.workspace_id, row);
      return [row] as T[];
    }

    if (text.includes("INSERT INTO skill_submissions")) {
      const idempotencyKey = params[10] === null ? null : String(params[10]);
      if (idempotencyKey) {
        const existing = [...this.submissions.values()].find((submission) =>
          submission.workspace_id === String(params[2]) &&
          submission.skill_name === String(params[5]) &&
          submission.idempotency_key === idempotencyKey
        );
        if (existing) {
          return [] as T[];
        }
      }
      const row: SubmissionRow = {
        id: String(params[0]),
        account_id: params[1] === null ? null : String(params[1]),
        workspace_id: String(params[2]),
        conversation_id: String(params[3]),
        assistant_message_id: params[4] === null ? null : String(params[4]),
        skill_name: String(params[5]),
        source_channel: params[6] === null ? null : String(params[6]),
        source_origin: params[7] === null ? null : String(params[7]),
        trigger_source: String(params[8]),
        trigger_reason: params[9] === null ? null : String(params[9]),
        idempotency_key: idempotencyKey,
        fields: JSON.parse(String(params[11])) as Record<string, unknown>,
        subject_identity: params[12] === null ? null : String(params[12]),
        status: "pending",
        attempts: 0,
        next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
        final_delivery_error: null,
        activity_trace: params[13],
        created_at: new Date("2026-05-04T10:00:00.000Z"),
        updated_at: new Date("2026-05-04T10:00:00.000Z"),
      };
      this.submissions.set(row.id, row);
      return [row] as T[];
    }

    if (text.includes("FROM skill_submissions") && text.includes("idempotency_key = $3")) {
      const row = [...this.submissions.values()].find((submission) =>
        submission.workspace_id === String(params[0]) &&
        submission.skill_name === String(params[1]) &&
        submission.idempotency_key === String(params[2])
      );
      return (row ? [row] : []) as T[];
    }

    if (text.includes("FROM skill_submissions") && text.includes("fields->>'email' AS email")) {
      const workspaceId = String(params[0]);
      const conversationId = String(params[1]);
      const skillName = String(params[2]);
      const rows = [...this.submissions.values()]
        .filter((submission) =>
          submission.workspace_id === workspaceId &&
          submission.conversation_id === conversationId &&
          submission.skill_name === skillName &&
          ["pending", "delivering", "delivered"].includes(submission.status) &&
          typeof submission.fields.email === "string"
        )
        .sort((left, right) => right.created_at.getTime() - left.created_at.getTime())
        .slice(0, 5)
        .map((submission) => ({ email: submission.fields.email }));
      return rows as T[];
    }

    if (text.includes("FROM skill_submissions") && text.includes("COUNT(*) OVER")) {
      const workspaceId = String(params[0]);
      const skillFilter = params[1] === null ? null : String(params[1]);
      const limit = Number(params[2]);
      const offset = Number(params[3]);
      let all = [...this.submissions.values()].filter((row) => row.workspace_id === workspaceId);
      if (skillFilter) {
        all = all.filter((row) => row.skill_name === skillFilter);
      }
      all.sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
      const total = all.length;
      return all.slice(offset, offset + limit).map((row) => ({ ...row, total_count: String(total) })) as T[];
    }

    if (text.includes("FROM skill_submissions") && text.includes("AND id = $2")) {
      const row = [...this.submissions.values()].find((submission) =>
        submission.workspace_id === String(params[0]) && submission.id === String(params[1])
      );
      return (row ? [row] : []) as T[];
    }

    if (text.includes("FROM skill_intake_states") && text.includes("SELECT")) {
      const workspaceId = String(params[0]);
      const conversationId = String(params[1]);
      const skillName = String(params[2]);
      const row = [...this.intakeStates.values()]
        .filter((candidate) =>
          candidate.workspace_id === workspaceId &&
          candidate.conversation_id === conversationId &&
          candidate.skill_name === skillName &&
          ["active", "paused", "awaiting_confirmation", "awaiting_tool"].includes(candidate.status) &&
          candidate.expires_at.getTime() > this.now.getTime()
        )
        .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime())[0];
      return (row ? [row] : []) as T[];
    }

    if (text.includes("INSERT INTO skill_intake_states")) {
      if (this.failNextSkillIntakeInsert) {
        this.failNextSkillIntakeInsert = false;
        throw new Error("skill intake insert failed");
      }
      const row: IntakeStateRow = {
        id: String(params[0]),
        workspace_id: String(params[1]),
        conversation_id: String(params[2]),
        skill_name: String(params[3]),
        status: String(params[4]) as IntakeStateRow["status"],
        collected: JSON.parse(String(params[5])) as Record<string, unknown>,
        invalid: {},
        missing: params[6] as string[],
        expires_at: new Date(String(params[7])),
        last_prompted_field: params[8] === null ? null : String(params[8]),
        created_at: new Date("2026-05-04T10:00:00.000Z"),
        updated_at: new Date("2026-05-04T10:00:00.000Z"),
      };
      this.intakeStates.set(row.id, row);
      return [row] as T[];
    }

    if (text.includes("UPDATE skill_intake_states") && text.includes("SET status = 'expired'")) {
      const workspaceId = String(params[0]);
      const conversationId = String(params[1]);
      const skillName = String(params[2]);
      for (const row of this.intakeStates.values()) {
        if (
          row.workspace_id === workspaceId &&
          row.conversation_id === conversationId &&
          row.skill_name === skillName &&
          ["active", "paused", "awaiting_confirmation", "awaiting_tool"].includes(row.status) &&
          row.expires_at.getTime() <= this.now.getTime()
        ) {
          row.status = "expired";
          row.collected = {};
          row.invalid = {};
          row.missing = [];
          row.last_prompted_field = null;
          row.updated_at = this.now;
        }
      }
      return [] as T[];
    }

    if (text.includes("UPDATE skill_intake_states")) {
      if (this.failNextSkillIntakeUpdate) {
        this.failNextSkillIntakeUpdate = false;
        throw new Error("skill intake update failed");
      }
      const row = this.intakeStates.get(String(params[0]));
      if (row) {
        row.status = String(params[1]) as IntakeStateRow["status"];
        row.collected = JSON.parse(String(params[2])) as Record<string, unknown>;
        row.missing = params[3] as string[];
        row.last_prompted_field = params[4] === null ? null : String(params[4]);
        row.updated_at = new Date("2026-05-04T10:02:00.000Z");
      }
      return [] as T[];
    }

    if (text.includes("UPDATE skill_submissions") && text.includes("SET status = 'delivering'")) {
      const maxAttempts = Number(params[0]);
      const limit = Number(params[1]);
      const dueRows = [...this.submissions.values()]
        .filter((row) => row.status === "pending" && row.attempts < maxAttempts)
        .slice(0, limit);
      for (const row of dueRows) {
        row.status = "delivering";
      }
      return dueRows.map((row) => ({ ...row })) as T[];
    }

    if (text.includes("UPDATE skill_submissions") && text.includes("SET status = 'delivered'")) {
      const row = this.submissions.get(String(params[0]));
      if (row) {
        row.status = "delivered";
        row.attempts += 1;
        row.final_delivery_error = null;
      }
      return [] as T[];
    }

    if (text.includes("UPDATE skill_submissions") && text.includes("SET status = 'failed'")) {
      const row = this.submissions.get(String(params[0]));
      if (row) {
        row.status = "failed";
        row.attempts += 1;
        row.final_delivery_error = String(params[1]);
        row.activity_trace = params[2];
      }
      return [] as T[];
    }

    if (text.includes("UPDATE skill_submissions") && text.includes("SET status = $2")) {
      const row = this.submissions.get(String(params[0]));
      if (row) {
        row.status = String(params[1]) as SubmissionRow["status"];
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
  database?: FakeSkillSubmissionDatabase;
  webhookFetch?: typeof fetch;
  chatGateway?: { answer(input: { prompt: string; query: string; history: Array<{ role: string; content: string }> }): Promise<string> };
  abuseControlService?: { enforce(input: { scope: string; subjectKey: string; limit: number; windowMs: number; blockMs?: number }): Promise<void> };
  mailService?: MailService;
  assertPublicWebsiteUrl?: (url: string) => Promise<void>;
} = {}) => {
  const database = input.database ?? new FakeSkillSubmissionDatabase();
  const auditEvents: unknown[] = [];
  const sentEmails: CapturedMail[] = [];
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
    workspaceContactInfoRepository: {
      async findById(workspaceId) {
        return { id: workspaceId, name: "Acme Workspace", publicRouteKey: "acme" };
      },
    },
    auditService: {
      async record(event) {
        auditEvents.push(event);
      },
    },
    abuseControlService: input.abuseControlService ?? {
      async enforce() {
        return undefined;
      },
    },
    mailService: input.mailService ?? {
      async send(message) {
        sentEmails.push(message);
      },
    },
    dashboardBaseUrl: "https://app.example.com",
    chatGateway: input.chatGateway ?? {
      async answer() {
        return "{}";
      },
    },
    webhookFetch: input.webhookFetch,
    assertPublicWebsiteUrl: input.assertPublicWebsiteUrl,
    startPoller: false,
  });

  return { service, database, auditEvents, sentEmails };
};

describe("resolveLanguageContext", () => {
  const baseInput = {
    workspaceId: "workspace-1",
    conversationId: "conv-1",
    userMessageId: "msg-current",
    query: "test@test",
    history: [],
    sourceChannel: null,
    sourceOrigin: null,
    anonymousSessionId: null,
    userExpectedLocale: null,
  } as Parameters<typeof resolveLanguageContext>[0];

  it("anchors language on the user's latest meaningful message, ignoring follow-up answers like an email", () => {
    const result = resolveLanguageContext({
      ...baseInput,
      query: "test@test",
      history: [
        { id: "u0", role: "user", content: "hey", createdAt: new Date() },
        { id: "u1", role: "user", content: "Я хочу поговорить с кем-нибудь.", createdAt: new Date() },
        { id: "a1", role: "assistant", content: "Please share your email.", createdAt: new Date() },
        { id: "u2", role: "user", content: "test@test", createdAt: new Date() },
      ],
    });
    expect(result).toBe("Я хочу поговорить с кем-нибудь.");
  });

  it("skips a short greeting before an explicit English contact request", () => {
    const result = resolveLanguageContext({
      ...baseInput,
      query: "i want to talk to someone",
      history: [
        { id: "u1", role: "user", content: "hey", createdAt: new Date() },
        { id: "a1", role: "assistant", content: "How can I help?", createdAt: new Date() },
        { id: "u2", role: "user", content: "i want to talk to someone", createdAt: new Date() },
      ],
    });
    expect(result).toBe("i want to talk to someone");
  });

  it("falls back to a short current query when no better language anchor exists", () => {
    const result = resolveLanguageContext({
      ...baseInput,
      query: "hey",
      history: [
        { id: "u1", role: "user", content: "hey", createdAt: new Date() },
      ],
    });
    expect(result).toBe("hey");
  });

  it("ignores the auto-built collected.message draft when resolving language anchor", () => {
    const result = resolveLanguageContext(
      {
        ...baseInput,
        history: [
          { id: "u1", role: "user", content: "私は人と話したいです。", createdAt: new Date() },
        ],
      },
      { message: "Contact request:\n\nI need help." },
    );
    expect(result).toBe("私は人と話したいです。");
  });

  it("falls back to the current query when no prior user message exists", () => {
    const result = resolveLanguageContext({
      ...baseInput,
      query: "Hello there",
      history: [],
    });
    expect(result).toBe("Hello there");
  });
});

describe("enterprise human contact service", () => {
  it("fails loudly when contact intake is constructed without a chat gateway", () => {
    expect(() => new DefinitionBackedIntakePrompts({
      skill: humanContactRequestSkillDefinition,
      chatGateway: undefined as never,
    })).toThrow("Skill intake human_contact.request requires a chat gateway.");
  });

  it("bounds best-effort intake prompt latency", async () => {
    const prompts = new DefinitionBackedIntakePrompts({
      skill: humanContactRequestSkillDefinition,
      timeoutMs: 1,
      chatGateway: {
        async answer() {
          return new Promise<string>(() => undefined);
        },
      },
    });

    await expect(prompts.shouldStart("I need a human.")).resolves.toBe(false);
    await expect(prompts.extractFields("alex@example.com")).resolves.toEqual({});
    await expect(prompts.composeAnswer({
      kind: "missing",
      fieldName: "email",
      languageContext: "I need a human.",
    })).rejects.toThrow("Skill intake human_contact.request answer prompt timed out");
  });

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
      defaultEmails: [],
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
    const database = new FakeSkillSubmissionDatabase();
    const { service, sentEmails } = createService({ database });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    database.submissions.set("request-1", {
      id: "request-1",
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      skill_name: "human_contact.request",
      source_channel: "authenticated_chat",
      source_origin: null,
      trigger_source: "manual",
      trigger_reason: null,
      idempotency_key: null,
      fields: { email: "user@example.com", message: "Please contact me." },
      subject_identity: "user@example.com",
      attempts: 0,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      final_delivery_error: null,
      activity_trace: null,
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:00:00.000Z"),
    });

    await service.processDueDeliveries(1);

    expect(sentEmails).toHaveLength(1);
    const sent = sentEmails[0]!;
    expect(sent.to).toBe("support@example.com");
    expect(sent.replyTo).toBe("user@example.com");
    expect(sent.subject).toBe("[Acme Workspace] New contact request from user@example.com");
    expect(sent.text).toContain("Please contact me.");
    expect(sent.text).toContain(
      "https://app.example.com/w/acme/activity?filter=contact&itemKind=contact&itemId=request-1",
    );
    expect(sent.text).toContain("Recent conversation:");
    expect(sent.text).toContain("Visitor: I need help with billing.");
    expect(sent.text).toContain("Assistant: I could not find that in the indexed documents.");
    expect(sent.metadata).toEqual({
      kind: "human_contact_request",
      requestId: "request-1",
      workspaceId: "workspace-1",
    });
    expect(database.submissions.get("request-1")?.status).toBe("delivered");
  });

  it("delivers contact request emails to each configured recipient", async () => {
    const database = new FakeSkillSubmissionDatabase();
    const { service, sentEmails } = createService({ database });
    const settings = await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmails: ["support@example.com", " Escalations@Example.com ", "support@example.com"],
    });

    expect(settings).toMatchObject({
      configured: true,
      defaultEmail: "support@example.com",
      defaultEmails: ["support@example.com", "Escalations@Example.com"],
    });

    database.submissions.set("request-1", {
      id: "request-1",
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      skill_name: "human_contact.request",
      source_channel: "authenticated_chat",
      source_origin: null,
      trigger_source: "manual",
      trigger_reason: null,
      idempotency_key: null,
      fields: { email: "user@example.com", message: "Please contact me." },
      subject_identity: "user@example.com",
      attempts: 0,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      final_delivery_error: null,
      activity_trace: null,
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:00:00.000Z"),
    });

    await service.processDueDeliveries(1);

    expect(sentEmails.map((message) => message.to)).toEqual([
      "support@example.com",
      "Escalations@Example.com",
    ]);
    expect(database.submissions.get("request-1")?.status).toBe("delivered");
  });

  it("continues sending remaining contact request emails when one recipient fails", async () => {
    const database = new FakeSkillSubmissionDatabase();
    const sentEmails: CapturedMail[] = [];
    const { service } = createService({
      database,
      mailService: {
        async send(message) {
          if (message.to === "broken@example.com") {
            throw new Error("mailbox unavailable");
          }
          sentEmails.push(message);
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmails: ["support@example.com", "broken@example.com", "escalations@example.com"],
    });

    database.submissions.set("request-1", {
      id: "request-1",
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      skill_name: "human_contact.request",
      source_channel: "authenticated_chat",
      source_origin: null,
      trigger_source: "manual",
      trigger_reason: null,
      idempotency_key: null,
      fields: { email: "user@example.com", message: "Please contact me." },
      subject_identity: "user@example.com",
      attempts: 0,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      final_delivery_error: null,
      activity_trace: null,
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:00:00.000Z"),
    });

    await service.processDueDeliveries(1);

    expect(sentEmails.map((message) => message.to)).toEqual([
      "support@example.com",
      "escalations@example.com",
    ]);
    expect(database.submissions.get("request-1")).toMatchObject({
      status: "pending",
      attempts: 1,
      final_delivery_error: "Email[broken@example.com]: mailbox unavailable",
    });
  });

  it("starts a chat intake for explicit human-contact requests and asks for email first", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "What email address should the team use to follow up?",
      "Received. The request will continue through the configured channel.",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
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

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "Please follow up about this request.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Please follow up about this request.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "active",
      answer: "What email address should the team use to follow up?",
    });
    expect([...database.intakeStates.values()]).toEqual([
      expect.objectContaining({
        status: "active",
        missing: ["email", "message"],
        last_prompted_field: "email",
        collected: {},
      }),
    ]);
    expect(database.submissions.size).toBe(0);
  });

  it("does not treat a short greeting plus handoff request as the message for the team", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "What email address should the team use to follow up?",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "I want to talk to someone",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "hey",
          createdAt: new Date("2026-05-04T09:59:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "I want to talk to someone",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "active",
      answer: "What email address should the team use to follow up?",
    });
    const [state] = [...database.intakeStates.values()];
    expect(state).toMatchObject({
      missing: ["email", "message"],
      last_prompted_field: "email",
      collected: {},
    });
  });

  it("starts contact intake from structured intent metadata without English intent matching", async () => {
    const prompts: string[] = [];
    const responses = [
      "{}",
      "¿Qué correo electrónico debería usar el equipo para responder?",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer(input) {
          prompts.push(input.prompt);
          return responses.shift() ?? "{}";
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

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "Quiero hablar con una persona.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Quiero hablar con una persona.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "website_embed",
      inputMetadata: {
        method: "intent_click",
        intent: {
          skillName: "human_contact.request",
          intentName: "explicit_contact_request",
        },
      },
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "active",
      answer: "¿Qué correo electrónico debería usar el equipo para responder?",
    });
    expect(prompts.join("\n")).not.toContain("should start the configured skill intake");
    expect([...database.intakeStates.values()]).toEqual([
      expect.objectContaining({
        status: "active",
        missing: ["email", "message"],
      }),
    ]);
  });

  it("expires stale open intake rows before starting a new intake for the same conversation", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("expired-state", {
      id: "expired-state",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: {
        message: "Contact request:\n\nOld request.",
      },
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T09:00:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T08:45:00.000Z"),
      updated_at: new Date("2026-05-04T08:45:00.000Z"),
    });
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "What email address should the team use to follow up?",
    ];
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "I want to talk to a human.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "I want to talk to a human.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "active",
    });
    expect(database.intakeStates.get("expired-state")).toMatchObject({
      status: "expired",
      collected: {},
      invalid: {},
      missing: [],
      last_prompted_field: null,
    });
    expect([...database.intakeStates.values()].filter((state) => state.status === "active")).toHaveLength(1);
  });

  it("queues a direct contact request when submitted confirmation generation falls back", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{\"fields\":{\"email\":\"alex@example.com\",\"message\":\"Please contact me about my account.\"}}",
      "",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "Please contact me at alex@example.com.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Please contact me at alex@example.com.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "completed",
      answer: "Your request was received and will be sent to the team.",
    });
    expect(database.submissions.size).toBe(1);
  });

  it("does not leave an active intake state when email prompt generation fails", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    await expect(service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "I want to talk to a human.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "I want to talk to a human.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    })).rejects.toThrow("Skill intake answer generation failed for human_contact.request.");

    expect(database.submissions.size).toBe(0);
    expect(database.intakeStates.size).toBe(0);
  });

  it("uses a stable idempotency key for repeated direct contact submissions", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{\"fields\":{\"email\":\"alex@example.com\",\"message\":\"Please contact me about my account.\"}}",
      "Received. The request will continue through the configured channel.",
      "{\"shouldStart\":true}",
      "{\"fields\":{\"email\":\"alex@example.com\",\"message\":\"Please contact me about my account.\"}}",
      "Received. The request will continue through the configured channel.",
    ];
    const { service, database, auditEvents } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const first = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "Please contact me at alex@example.com.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Please contact me at alex@example.com.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });
    const second = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "Please contact me at alex@example.com.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Please contact me at alex@example.com.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        {
          id: "assistant-message-1",
          role: "assistant",
          content: "Received. The request will continue through the configured channel.",
          createdAt: new Date("2026-05-04T10:00:30.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "Please contact me at alex@example.com.",
          createdAt: new Date("2026-05-04T10:01:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(first?.status).toBe("completed");
    expect(second?.status).toBe("completed");
    expect(database.submissions.size).toBe(1);
    expect([...database.submissions.values()][0]?.idempotency_key).toMatch(/^human-contact:intake:direct:/);
    for (const state of database.intakeStates.values()) {
      expect(state).toMatchObject({
        status: "completed",
        collected: {
          submitted: true,
          requestId: expect.any(String),
        },
      });
      expect(JSON.stringify(state.collected)).not.toContain("alex@example.com");
      expect(JSON.stringify(state.collected)).not.toContain("Please contact me");
    }
    expect(auditEvents.filter((event) =>
      typeof event === "object" &&
      event !== null &&
      (event as { eventType?: unknown }).eventType === "human_contact.request_received"
    )).toHaveLength(1);
  });

  it("queues distinct direct contact submissions in the same conversation", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{\"fields\":{\"email\":\"alex@example.com\",\"message\":\"Please contact me about billing.\"}}",
      "Received. The request will continue through the configured channel.",
      "{\"shouldStart\":true}",
      "{\"fields\":{\"email\":\"alex@example.com\",\"message\":\"Please contact me about a security issue.\"}}",
      "Received. The request will continue through the configured channel.",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "Please contact me at alex@example.com about billing.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Please contact me at alex@example.com about billing.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });
    await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "Please contact me at alex@example.com about a security issue.",
      history: [
        {
          id: "user-message-2",
          role: "user",
          content: "Please contact me at alex@example.com about a security issue.",
          createdAt: new Date("2026-05-04T10:01:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(database.submissions.size).toBe(2);
    expect([...database.submissions.values()].map((submission) => submission.fields.message)).toEqual([
      expect.stringContaining("about billing"),
      expect.stringContaining("security issue"),
    ]);
  });

  it("reuses the latest submitted contact email in the same conversation", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{\"fields\":{\"email\":\"alex@example.com\",\"message\":\"Please contact me about billing.\"}}",
      "Received. The request will continue through the configured channel.",
      "{\"shouldStart\":true}",
      "{\"fields\":{\"message\":\"Please contact me about a security issue.\"}}",
      "Received. The request will continue through the configured channel.",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const first = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "Please contact me at alex@example.com about billing.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Please contact me at alex@example.com about billing.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });
    const second = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "Please contact me about a security issue.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Please contact me at alex@example.com about billing.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        {
          id: "assistant-message-1",
          role: "assistant",
          content: "Received. The request will continue through the configured channel.",
          createdAt: new Date("2026-05-04T10:00:30.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "Please contact me about a security issue.",
          createdAt: new Date("2026-05-04T10:01:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(first).toMatchObject({ status: "completed" });
    expect(second).toMatchObject({ status: "completed" });
    expect([...database.submissions.values()]).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({
          email: "alex@example.com",
          message: "Please contact me about billing.",
        }),
      }),
      expect.objectContaining({
        fields: expect.objectContaining({
          email: "alex@example.com",
          message: "Please contact me about a security issue.",
        }),
      }),
    ]);
    for (const state of database.intakeStates.values()) {
      expect(JSON.stringify(state.collected)).not.toContain("alex@example.com");
    }
  });

  it("returns a completed direct intake response when post-submit state insert fails", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{\"fields\":{\"email\":\"alex@example.com\",\"message\":\"Please contact me about my account.\"}}",
      "Received. The request will continue through the configured channel.",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });
    database.failNextSkillIntakeInsert = true;

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "Please contact me at alex@example.com.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Please contact me at alex@example.com.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "completed",
      answer: "Received. The request will continue through the configured channel.",
    });
    expect(result?.stateId).toBeUndefined();
    expect(database.submissions.size).toBe(1);
  });

  it("keeps the prior user issue in the contact draft when the latest turn only starts handoff", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "What email address should the team use to follow up?",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "I want to talk to a human.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Why was invoice 123 charged twice?",
          createdAt: new Date("2026-05-04T09:58:00.000Z"),
        },
        {
          id: "assistant-message-1",
          role: "assistant",
          content: "I could not find that invoice in the indexed documents.",
          createdAt: new Date("2026-05-04T09:59:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "I want to talk to a human.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result?.status).toBe("active");
    const [state] = [...database.intakeStates.values()];
    expect(state?.collected).toMatchObject({
      message: expect.stringContaining("Why was invoice 123 charged twice?"),
    });

    await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-3",
      query: "alex@example.com",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Why was invoice 123 charged twice?",
          createdAt: new Date("2026-05-04T09:58:00.000Z"),
        },
        {
          id: "assistant-message-1",
          role: "assistant",
          content: "I could not find that invoice in the indexed documents.",
          createdAt: new Date("2026-05-04T09:59:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "I want to talk to a human.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        {
          id: "user-message-3",
          role: "user",
          content: "alex@example.com",
          createdAt: new Date("2026-05-04T10:01:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    const [submission] = [...database.submissions.values()];
    const submittedMessage = String(submission?.fields.message ?? "");
    expect(submittedMessage).toContain("User issue:\nWhy was invoice 123 charged twice?");
    expect(submittedMessage).toContain("Latest contact request:\nI want to talk to a human.");
    expect(submittedMessage).toContain("User: Why was invoice 123 charged twice?");
    expect(submittedMessage).toContain("Assistant: I could not find that invoice in the indexed documents.");
  });

  it("passes the user's message as language context when composing intake replies", async () => {
    const prompts: string[] = [];
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "Quale indirizzo email dovrebbe usare il team per ricontattarti?",
    ];
    const { service } = createService({
      chatGateway: {
        async answer(input: { prompt: string }) {
          prompts.push(input.prompt);
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "Volevo parlare con una persona.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Volevo parlare con una persona.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      status: "active",
      answer: "Quale indirizzo email dovrebbe usare il team per ricontattarti?",
    });
    expect(prompts.at(-1)).toContain("Reply in exactly the same natural language the user used in the anchor message below.");
    expect(prompts.at(-1)).toContain("The user's anchor message in this conversation was: Volevo parlare con una persona.");
  });

  it("uses the explicit contact request rather than an earlier greeting as the intake language anchor", async () => {
    const prompts: string[] = [];
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "Sure, what email address should the team use to follow up?",
    ];
    const { service } = createService({
      chatGateway: {
        async answer(input: { prompt: string }) {
          prompts.push(input.prompt);
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "i want to talk to someone",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "hey",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        {
          id: "assistant-message-1",
          role: "assistant",
          content: "How can I help?",
          createdAt: new Date("2026-05-04T10:00:05.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "i want to talk to someone",
          createdAt: new Date("2026-05-04T10:01:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
      userExpectedLocale: "en-US",
    });

    expect(result).toMatchObject({
      status: "active",
      answer: "Sure, what email address should the team use to follow up?",
    });
    expect(prompts.at(-1)).toContain("The user's anchor message in this conversation was: i want to talk to someone");
    expect(prompts.at(-1)).not.toContain("The user's anchor message in this conversation was: hey");
  });

  it("does not mix a browser locale fallback into a meaningful language anchor prompt", async () => {
    const prompts: string[] = [];
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "Sure, what email address should the team use to follow up?",
    ];
    const { service } = createService({
      chatGateway: {
        async answer(input: { prompt: string }) {
          prompts.push(input.prompt);
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "I'd like to talk to someone.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "hey",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "I'd like to talk to someone.",
          createdAt: new Date("2026-05-04T10:01:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
      userExpectedLocale: "es-ES",
    });

    expect(prompts.at(-1)).toContain("The user's anchor message in this conversation was: I'd like to talk to someone.");
    expect(prompts.at(-1)).toContain("Ignore browser locale hints");
    expect(prompts.at(-1)).not.toContain("fall back to locale es-ES");
  });

  it("resumes a paused chat intake when the user provides the missing email", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: {
        message: "Contact request:\n\nI need help with billing.",
      },
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return "Received. The request will continue through the configured channel.";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "alex@example.com",
      history: [
        {
          id: "user-message-2",
          role: "user",
          content: "alex@example.com",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "completed",
      answer: "Received. The request will continue through the configured channel.",
    });
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "completed",
      missing: [],
      collected: {
        submitted: true,
        requestId: expect.any(String),
      },
    });
    expect(JSON.stringify(database.intakeStates.get("state-1")?.collected)).not.toContain("alex@example.com");
    expect(JSON.stringify(database.intakeStates.get("state-1")?.collected)).not.toContain("I need help with billing.");
    expect([...database.submissions.values()]).toEqual([
      expect.objectContaining({
        subject_identity: "alex@example.com",
        fields: expect.objectContaining({
          email: "alex@example.com",
          message: expect.stringContaining("I need help with billing."),
        }),
        trigger_source: "explicit_user_request",
      }),
    ]);
  });

  it("reuses the stored intake language anchor when a later email turn has no language signal", async () => {
    const database = new FakeSkillSubmissionDatabase();
    const prompts: string[] = [];
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "Sure, what email address should the team use to follow up?",
      "Received. The team will follow up with you.",
    ];
    const { service } = createService({
      database,
      chatGateway: {
        async answer(input: { prompt: string }) {
          prompts.push(input.prompt);
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "Can I book with a human?",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "I need help booking an appointment.",
          createdAt: new Date("2026-05-04T09:58:00.000Z"),
        },
        {
          id: "assistant-message-1",
          role: "assistant",
          content: "I could not find appointment booking details in the indexed documents.",
          createdAt: new Date("2026-05-04T09:59:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "Can I book with a human?",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "website_embed",
      userExpectedLocale: "pl-PL",
    });

    await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-3",
      query: "alex@example.com",
      history: [
        {
          id: "user-message-3",
          role: "user",
          content: "alex@example.com",
          createdAt: new Date("2026-05-04T10:01:00.000Z"),
        },
      ],
      sourceChannel: "website_embed",
      userExpectedLocale: "pl-PL",
    });

    expect(prompts.at(-1)).toContain("The user's anchor message in this conversation was: Can I book with a human?");
    expect(prompts.at(-1)).not.toContain("fall back to locale pl-PL");
    expect([...database.submissions.values()]).toHaveLength(1);
  });

  it("returns a completed resumed intake response when post-submit state update fails", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: {
        message: "Contact request:\n\nI need help with billing.",
      },
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return "Received. The request will continue through the configured channel.";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });
    database.failNextSkillIntakeUpdate = true;

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "alex@example.com",
      history: [
        {
          id: "user-message-2",
          role: "user",
          content: "alex@example.com",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "completed",
      stateId: "state-1",
      answer: "Received. The request will continue through the configured channel.",
    });
    expect(database.submissions.size).toBe(1);
  });

  it("returns a failed intake response when completed contact submission is rejected", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: {
        message: "Contact request:\n\nI need help with billing.",
      },
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const responses = [
      "I could not submit that request right now. Please try again later.",
    ];
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
      abuseControlService: {
        async enforce() {
          throw new Error("rate limit exceeded");
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "alex@example.com",
      history: [
        {
          id: "message-1",
          role: "user",
          content: "I need help with billing.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "alex@example.com",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "failed",
      stateId: "state-1",
      answer: "I could not submit that request right now. Please try again later.",
    });
    expect(database.submissions.size).toBe(0);
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "failed",
      collected: {},
      missing: [],
      last_prompted_field: null,
    });
  });

  it("keeps the email intake active when the user provides an invalid email-like value", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: {
        message: "Contact request:\n\nI need help with billing.",
      },
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return "That email address does not look valid. What email address should the team use?";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "tets@test",
      history: [
        {
          id: "user-message-2",
          role: "user",
          content: "tets@test",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "active",
      answer: "That email address does not look valid. What email address should the team use?",
    });
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "active",
      missing: ["email"],
      last_prompted_field: "email",
    });
    expect(database.submissions.size).toBe(0);
  });

  it("pauses an active contact intake when a later message only mentions an email", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: {},
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const responses = [
      "{\"fields\":{\"email\":\"support@example.com\"}}",
      "{\"shouldStart\":false}",
    ];
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "What is support@example.com used for?",
      history: [
        {
          id: "user-message-2",
          role: "user",
          content: "What is support@example.com used for?",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toBeNull();
    expect(database.submissions.size).toBe(0);
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "paused",
      collected: {},
      missing: ["email"],
      last_prompted_field: "email",
    });
  });

  it("accepts a natural prose email reply while active contact intake is waiting for email", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: {
        message: "Contact request:\n\nI need help with billing.",
      },
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const responses = [
      "{\"fields\":{\"email\":\"alex@example.com\"}}",
      "Received. The request will continue through the configured channel.",
    ];
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "my email is alex@example.com",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "I want to talk to a human.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "my email is alex@example.com",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "completed",
      stateId: "state-1",
      answer: "Received. The request will continue through the configured channel.",
    });
    expect(database.submissions.size).toBe(1);
    expect([...database.submissions.values()][0]).toMatchObject({
      fields: expect.objectContaining({ email: "alex@example.com" }),
    });
  });

  it("re-prompts for email when a paused intake receives another explicit human-contact request", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "paused",
      collected: {
        message: "Contact request:\n\nI need help with billing.",
      },
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const responses = [
      "{}",
      "{\"shouldStart\":true}",
      "What email address should the team use to follow up?",
    ];
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "I still want to talk to a human.",
      history: [
        {
          id: "user-message-2",
          role: "user",
          content: "I still want to talk to a human.",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "active",
      answer: "What email address should the team use to follow up?",
    });
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "active",
      missing: ["email"],
      last_prompted_field: "email",
    });
    expect(database.submissions.size).toBe(0);
  });

  it("reuses a submitted conversation email when a paused intake is still missing email", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.submissions.set("request-1", {
      id: "request-1",
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      skill_name: "human_contact.request",
      source_channel: "authenticated_chat",
      source_origin: null,
      trigger_source: "explicit_user_request",
      trigger_reason: "The user completed a human-contact chat intake.",
      idempotency_key: "human-contact:intake:previous-state",
      fields: { email: "alex@example.com", message: "Earlier request." },
      subject_identity: "alex@example.com",
      attempts: 0,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      final_delivery_error: null,
      activity_trace: null,
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:00:00.000Z"),
    });
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "paused",
      collected: {
        message: "Contact request:\n\nI need help with billing.",
      },
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const responses = [
      "{}",
      "{\"shouldStart\":true}",
      "Received. The request will continue through the configured channel.",
    ];
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "I still want to talk to a human.",
      history: [
        {
          id: "user-message-2",
          role: "user",
          content: "I still want to talk to a human.",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "completed",
      answer: "Received. The request will continue through the configured channel.",
    });
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "completed",
      missing: [],
      collected: {
        submitted: true,
        requestId: expect.any(String),
      },
    });
    expect([...database.submissions.values()]).toHaveLength(2);
    expect([...database.submissions.values()][1]).toMatchObject({
      fields: expect.objectContaining({
        email: "alex@example.com",
        message: expect.stringContaining("I need help with billing."),
      }),
    });
    expect(JSON.stringify(database.intakeStates.get("state-1")?.collected)).not.toContain("alex@example.com");
  });

  it("does not resume a paused contact intake from an unrelated later email", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "paused",
      collected: {},
      invalid: {},
      missing: ["email"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return "{\"shouldStart\":false}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "finance@example.com",
      history: [
        {
          id: "user-message-2",
          role: "user",
          content: "finance@example.com",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toBeNull();
    expect(database.submissions.size).toBe(0);
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "paused",
      collected: {},
      missing: ["email"],
      last_prompted_field: "email",
    });
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
      email: " User@Example.com ",
      message: "Please contact me.",
      triggerSource: "manual",
    });

    expect(database.submissions.get(result.requestId)).toMatchObject({
      fields: { email: " User@Example.com ", message: "Please contact me." },
      subject_identity: "user@example.com",
    });
  });

  it("returns the original contact request for repeated idempotent submissions", async () => {
    const { service, database, auditEvents } = createService();
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const first = await service.submit({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      email: "user@example.com",
      message: "Please contact me.",
      triggerSource: "explicit_user_request",
      idempotencyKey: "human-contact:intake:state-1",
    });
    const second = await service.submit({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      email: "user@example.com",
      message: "Please contact me.",
      triggerSource: "explicit_user_request",
      idempotencyKey: "human-contact:intake:state-1",
    });

    expect(second.requestId).toBe(first.requestId);
    expect(database.submissions.size).toBe(1);
    expect([...database.submissions.values()][0]).toMatchObject({
      idempotency_key: "human-contact:intake:state-1",
    });
    expect(auditEvents.filter((event) =>
      typeof event === "object" &&
      event !== null &&
      (event as { eventType?: unknown }).eventType === "human_contact.request_received"
    )).toHaveLength(1);
  });

  it("ignores client-only assistant message IDs when storing submitted messages", async () => {
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
      assistantMessageId: "11111111-1111-4111-8111-111111111111",
      email: "user@example.com",
      message: "Please contact me.",
      triggerSource: "manual",
    });

    expect(database.submissions.get(result.requestId)).toMatchObject({
      assistant_message_id: null,
      fields: { email: "user@example.com", message: "Please contact me." },
    });
  });

  it("signs webhook deliveries and marks successful requests delivered", async () => {
    const database = new FakeSkillSubmissionDatabase();
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
    database.submissions.set(requestId, {
      id: requestId,
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      skill_name: "human_contact.request",
      source_channel: "authenticated_chat",
      source_origin: null,
      trigger_source: "manual",
      trigger_reason: null,
      idempotency_key: null,
      fields: { email: "user@example.com", message: "Please contact me." },
      subject_identity: "user@example.com",
      attempts: 0,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      final_delivery_error: null,
      activity_trace: null,
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:00:00.000Z"),
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
    expect(database.submissions.get(requestId)?.status).toBe("delivered");
  });

  it("validates stored webhook URLs before delivery", async () => {
    const database = new FakeSkillSubmissionDatabase();
    let fetchCalled = false;
    const { service } = createService({
      database,
      assertPublicWebsiteUrl: async () => {
        throw new Error("private webhook URL is not allowed");
      },
      webhookFetch: (async () => {
        fetchCalled = true;
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

    database.submissions.set("request-1", {
      id: "request-1",
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      skill_name: "human_contact.request",
      source_channel: "authenticated_chat",
      source_origin: null,
      trigger_source: "manual",
      trigger_reason: null,
      idempotency_key: null,
      fields: { email: "user@example.com", message: "Please contact me." },
      subject_identity: "user@example.com",
      attempts: 0,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      final_delivery_error: null,
      activity_trace: null,
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:00:00.000Z"),
    });

    await service.processDueDeliveries(1);

    expect(fetchCalled).toBe(false);
    expect(database.submissions.get("request-1")).toMatchObject({
      status: "pending",
      attempts: 1,
      final_delivery_error: "Webhook: private webhook URL is not allowed",
    });
  });

  it("marks webhook deliveries failed after the terminal retry attempt", async () => {
    const database = new FakeSkillSubmissionDatabase();
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

    database.submissions.set("request-1", {
      id: "request-1",
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      skill_name: "human_contact.request",
      source_channel: "authenticated_chat",
      source_origin: null,
      trigger_source: "manual",
      trigger_reason: null,
      idempotency_key: null,
      fields: { email: "user@example.com", message: "Please contact me." },
      subject_identity: "user@example.com",
      attempts: 7,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      final_delivery_error: null,
      activity_trace: null,
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:00:00.000Z"),
    });

    await service.processDueDeliveries(1);

    expect(database.submissions.get("request-1")).toMatchObject({
      status: "failed",
      attempts: 8,
      final_delivery_error: "Webhook: HTTP 500",
    });
  });

  it("audits invalid stored submission fields when delivery claims quarantine a row", async () => {
    const database = new FakeSkillSubmissionDatabase();
    const { service, auditEvents } = createService({ database });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    database.submissions.set("request-invalid", {
      id: "request-invalid",
      account_id: "account-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: null,
      skill_name: "human_contact.request",
      source_channel: "authenticated_chat",
      source_origin: null,
      trigger_source: "manual",
      trigger_reason: null,
      idempotency_key: null,
      fields: { email: "not an email", message: "Please contact me." },
      subject_identity: "not an email",
      attempts: 0,
      status: "pending",
      next_retry_at: new Date("2026-05-04T10:00:00.000Z"),
      final_delivery_error: null,
      activity_trace: null,
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:00:00.000Z"),
    });

    await service.processDueDeliveries(1);

    expect(database.submissions.get("request-invalid")).toMatchObject({
      status: "failed",
      attempts: 1,
      final_delivery_error: expect.stringContaining("failed validation"),
    });
    expect(auditEvents).toContainEqual(expect.objectContaining({
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "human_contact.delivery_failed",
      eventStatus: "failure",
      metadata: expect.objectContaining({
        requestId: "request-invalid",
        conversationId: "conversation-1",
        skillName: "human_contact.request",
        failureKind: "stored_field_validation",
        attempts: 1,
        reason: expect.stringContaining("failed validation"),
      }),
    }));
  });

  it("prompts for the message after the user provides email when no prior context exists", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: {},
      invalid: {},
      missing: ["email", "message"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "email",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return "What message would you like the team to receive?";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "alex@example.com",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "I want to talk to a human.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "alex@example.com",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "active",
      stateId: "state-1",
      answer: "What message would you like the team to receive?",
    });
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "active",
      missing: ["message"],
      last_prompted_field: "message",
      collected: { email: "alex@example.com" },
    });
    expect(database.submissions.size).toBe(0);
  });

  it("submits the request after the user provides the missing message", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: { email: "alex@example.com" },
      invalid: {},
      missing: ["message"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "message",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return "Got it — the team will reach out shortly.";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-3",
      query: "My invoice 123 was charged twice — please refund it.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "I want to talk to a human.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "alex@example.com",
          createdAt: new Date("2026-05-04T10:02:00.000Z"),
        },
        {
          id: "user-message-3",
          role: "user",
          content: "My invoice 123 was charged twice — please refund it.",
          createdAt: new Date("2026-05-04T10:03:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "completed",
      stateId: "state-1",
      answer: "Got it — the team will reach out shortly.",
    });
    expect([...database.submissions.values()]).toEqual([
      expect.objectContaining({
        fields: {
          email: "alex@example.com",
          message: "My invoice 123 was charged twice — please refund it.",
        },
        trigger_source: "explicit_user_request",
      }),
    ]);
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "completed",
      missing: [],
    });
  });

  it("re-asks for the message when the user reply is empty", async () => {
    const database = new FakeSkillSubmissionDatabase();
    database.intakeStates.set("state-1", {
      id: "state-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      skill_name: "human_contact.request",
      status: "active",
      collected: { email: "alex@example.com" },
      invalid: {},
      missing: ["message"],
      expires_at: new Date("2026-05-04T10:15:00.000Z"),
      last_prompted_field: "message",
      created_at: new Date("2026-05-04T10:00:00.000Z"),
      updated_at: new Date("2026-05-04T10:01:00.000Z"),
    });
    const { service } = createService({
      database,
      chatGateway: {
        async answer() {
          return "Could you share the message you'd like us to send?";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-3",
      query: "   ",
      history: [
        {
          id: "user-message-3",
          role: "user",
          content: "   ",
          createdAt: new Date("2026-05-04T10:03:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "active",
      stateId: "state-1",
      answer: "Could you share the message you'd like us to send?",
    });
    expect(database.submissions.size).toBe(0);
    expect(database.intakeStates.get("state-1")).toMatchObject({
      status: "active",
      missing: ["message"],
      last_prompted_field: "message",
    });
  });

  it("uses prior conversation context as the message without asking for it", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{}",
      "What email address should the team use to follow up?",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-2",
      query: "I want to talk to a human.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Why was invoice 123 charged twice?",
          createdAt: new Date("2026-05-04T09:58:00.000Z"),
        },
        {
          id: "assistant-message-1",
          role: "assistant",
          content: "I could not find that invoice in the indexed documents.",
          createdAt: new Date("2026-05-04T09:59:00.000Z"),
        },
        {
          id: "user-message-2",
          role: "user",
          content: "I want to talk to a human.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result?.status).toBe("active");
    expect(result?.answer).toBe("What email address should the team use to follow up?");
    const [state] = [...database.intakeStates.values()];
    expect(state).toMatchObject({
      missing: ["email"],
      last_prompted_field: "email",
    });
    expect(state?.collected).toMatchObject({
      message: expect.stringContaining("Why was invoice 123 charged twice?"),
    });
  });

  it("submits directly when both email and message are extractable from the initial query", async () => {
    const responses = [
      "{\"shouldStart\":true}",
      "{\"fields\":{\"email\":\"alex@example.com\",\"message\":\"Please refund my duplicate invoice.\"}}",
      "Thanks — your request is on its way to the team.",
    ];
    const { service, database } = createService({
      chatGateway: {
        async answer() {
          return responses.shift() ?? "{}";
        },
      },
    });
    await service.updateSettings({
      workspaceId: "workspace-1",
      enabled: true,
      emailEnabled: true,
      defaultEmail: "support@example.com",
    });

    const result = await service.handle({
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      userMessageId: "user-message-1",
      query: "Please refund my duplicate invoice — alex@example.com.",
      history: [
        {
          id: "user-message-1",
          role: "user",
          content: "Please refund my duplicate invoice — alex@example.com.",
          createdAt: new Date("2026-05-04T10:00:00.000Z"),
        },
      ],
      sourceChannel: "authenticated_chat",
    });

    expect(result).toMatchObject({
      skillName: "human_contact.request",
      status: "completed",
      answer: "Thanks — your request is on its way to the team.",
    });
    expect([...database.submissions.values()]).toEqual([
      expect.objectContaining({
        fields: {
          email: "alex@example.com",
          message: "Please refund my duplicate invoice.",
        },
      }),
    ]);
  });
});
