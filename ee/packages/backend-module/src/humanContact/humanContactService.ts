import { createHmac, randomUUID, randomBytes } from "node:crypto";

import type {
  ChatActionProvider,
  ChatActionSuggestion,
  ContactHistoryDetail,
  ContactHistorySummary,
  UsageLimitDatabaseClient,
  UsageLimitDatabasePort,
} from "../radiosoModuleTypes.js";

type Logger = {
  info?(entry: unknown, message?: string): void;
  warn?(entry: unknown, message?: string): void;
  error(entry: unknown, message?: string): void;
};

type ChatGateway = {
  answer(input: { query: string; history: Array<{ role: string; content: string }>; prompt: string; systemPrompt?: string }): Promise<string>;
};

type EmailService = {
  send(message: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
};

interface ConversationRepository {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{
    id: string;
    workspaceId: string;
    sourceChannel: string | null;
    sourceOrigin: string | null;
    anonymousSessionId: string | null;
  } | null>;
  findByIdAndAnonymousSession(conversationId: string, workspaceId: string, anonymousSessionId: string): Promise<{
    id: string;
    workspaceId: string;
    sourceChannel: string | null;
    sourceOrigin: string | null;
    anonymousSessionId: string | null;
  } | null>;
}

interface MessageRepository {
  listRecentByConversationId(workspaceId: string, conversationId: string, limit: number): Promise<Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: Date;
  }>>;
}

interface AuditService {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

interface AbuseControlService {
  enforce(input: {
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  }): Promise<void>;
}

interface HumanContactSettingsRow {
  workspace_id: string;
  enabled: boolean;
  email_enabled: boolean;
  default_email: string | null;
  webhook_enabled: boolean;
  webhook_url: string | null;
  signing_secret: string | null;
  updated_at: Date;
}

interface HumanContactRequestRow {
  id: string;
  account_id: string | null;
  workspace_id: string;
  conversation_id: string;
  assistant_message_id: string | null;
  source_channel: string | null;
  source_origin: string | null;
  user_email: string;
  message: string;
  trigger_source: string;
  trigger_reason: string | null;
  attempts: number;
  created_at: Date;
}

interface HumanContactHistoryRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  assistant_message_id: string | null;
  source_channel: string | null;
  source_origin: string | null;
  user_email: string;
  message: string;
  trigger_source: string;
  trigger_reason: string | null;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  final_delivery_error: string | null;
  created_at: Date;
  updated_at: Date;
  total_count?: string;
}

const MAX_ATTEMPTS = 8;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const PUBLIC_CONTACT_LIMIT = 3;
const AUTHENTICATED_CONTACT_LIMIT = 10;
const CONTACT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const queryRows = async <T = Record<string, unknown>>(
  client: UsageLimitDatabaseClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const result = await client.query<T>(text, params);
  return Array.isArray(result) ? result : result.rows;
};

const normalizeOptionalText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const generateSecret = (): string => randomBytes(32).toString("base64url");

const serializeDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const normalizePreview = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 180);

const mapContactHistorySummary = (row: HumanContactHistoryRow): ContactHistorySummary => ({
  id: row.id,
  sortAt: serializeDate(row.created_at),
  workspaceId: row.workspace_id,
  conversationId: row.conversation_id,
  assistantMessageId: row.assistant_message_id,
  sourceChannel: row.source_channel,
  sourceOrigin: row.source_origin,
  userEmail: row.user_email,
  messagePreview: normalizePreview(row.message),
  triggerSource: row.trigger_source,
  triggerReason: row.trigger_reason,
  status: row.status,
  attempts: row.attempts,
  createdAt: serializeDate(row.created_at),
  updatedAt: serializeDate(row.updated_at),
});

const mapContactHistoryDetail = (row: HumanContactHistoryRow): ContactHistoryDetail => ({
  ...mapContactHistorySummary(row),
  message: row.message,
  finalDeliveryError: row.final_delivery_error,
});

const mapSettings = (row: HumanContactSettingsRow | undefined | null) => {
  const webhookUrl = row?.webhook_url ?? null;
  const signingSecretConfigured = Boolean(row?.signing_secret);
  const emailEnabled = Boolean(row?.email_enabled);
  const defaultEmail = row?.default_email ?? null;
  const webhookEnabled = Boolean(row?.webhook_enabled);
  const enabled = Boolean(row?.enabled);
  const emailConfigured = emailEnabled && Boolean(defaultEmail);
  const webhookConfigured = webhookEnabled && Boolean(webhookUrl) && signingSecretConfigured;
  return {
    enabled,
    configured: enabled && (emailConfigured || webhookConfigured),
    emailEnabled,
    defaultEmail,
    webhookEnabled,
    webhookUrl,
    signingSecretConfigured,
    updatedAt: row?.updated_at ? serializeDate(row.updated_at) : null,
  };
};

const explicitHumanRequestPatterns = [
  /\b(human|person|agent|representative|support|someone)\b/i,
  /\b(talk|speak|chat|contact|connect|reach)\s+(to|with)?\s*(a|an)?\s*(human|person|agent|representative|support|someone)\b/i,
  /\bcan i (talk|speak) to\b/i,
];

const isExplicitHumanRequest = (query: string): boolean =>
  explicitHumanRequestPatterns.some((pattern) => pattern.test(query));

const parseClassifierDecision = (value: string): boolean => {
  try {
    const parsed = JSON.parse(value) as { shouldSuggest?: unknown };
    return parsed.shouldSuggest === true;
  } catch {
    return /\btrue\b/i.test(value);
  }
};

export class EnterpriseHumanContactService implements ChatActionProvider {
  private readonly chatGateway?: ChatGateway;
  private readonly pollInterval?: NodeJS.Timeout;

  constructor(private readonly input: {
    database: UsageLimitDatabasePort;
    logger: Logger;
    conversationRepository: ConversationRepository;
    messageRepository: MessageRepository;
    auditService: AuditService;
    abuseControlService: AbuseControlService;
    emailService: EmailService;
    chatGateway?: unknown;
    pollIntervalMs?: number;
    webhookFetch?: typeof fetch;
    startPoller?: boolean;
  }) {
    this.chatGateway = this.isChatGateway(input.chatGateway) ? input.chatGateway : undefined;
    if (input.startPoller ?? true) {
      const intervalMs = input.pollIntervalMs ?? Number(process.env.EE_HUMAN_CONTACT_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
      this.pollInterval = setInterval(() => {
        void this.processDueDeliveries().catch((error) => {
          this.input.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            "Human contact delivery poll failed",
          );
        });
      }, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_POLL_INTERVAL_MS);
      this.pollInterval.unref?.();
    }
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  async getAvailability(input: { workspaceId: string }) {
    const settings = await this.findSettings(input.workspaceId);
    return {
      enabled: settings.enabled,
      configured: settings.configured,
    };
  }

  async listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number } = { limit: 50, offset: 0 },
  ) {
    const offset = input.offset ?? 0;
    const rows = await queryRows<HumanContactHistoryRow>(
      this.input.database,
      `SELECT
         COUNT(*) OVER()::text AS total_count,
         id::text,
         workspace_id::text,
         conversation_id::text,
         assistant_message_id::text,
         source_channel,
         source_origin,
         user_email,
         message,
         trigger_source,
         trigger_reason,
         status,
         attempts,
         final_delivery_error,
         created_at,
         updated_at
       FROM ee_contact_requests
       WHERE workspace_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2
       OFFSET $3`,
      [workspaceId, input.limit, offset],
    );
    const total = Number(rows[0]?.total_count ?? "0");
    const contacts = rows.map(mapContactHistorySummary);

    return {
      contacts,
      total,
      nextCursor: null,
      hasMore: offset + contacts.length < total,
    };
  }

  async getById(workspaceId: string, requestId: string): Promise<ContactHistoryDetail | null> {
    const [row] = await queryRows<HumanContactHistoryRow>(
      this.input.database,
      `SELECT
         id::text,
         workspace_id::text,
         conversation_id::text,
         assistant_message_id::text,
         source_channel,
         source_origin,
         user_email,
         message,
         trigger_source,
         trigger_reason,
         status,
         attempts,
         final_delivery_error,
         created_at,
         updated_at
       FROM ee_contact_requests
       WHERE workspace_id = $1
         AND id = $2
       LIMIT 1`,
      [workspaceId, requestId],
    );

    return row ? mapContactHistoryDetail(row) : null;
  }

  async getSettings(input: { workspaceId: string; accountId?: string | null }) {
    return this.findSettings(input.workspaceId);
  }

  async updateSettings(input: {
    workspaceId: string;
    accountId?: string | null;
    enabled: boolean;
    emailEnabled?: boolean;
    defaultEmail?: string | null;
    webhookEnabled?: boolean;
    webhookUrl?: string | null;
    signingSecret?: string | null;
    rotateSigningSecret?: boolean;
  }) {
    const existing = await this.findSettingsRow(input.workspaceId);
    const emailEnabled = input.emailEnabled ?? existing?.email_enabled ?? false;
    const defaultEmail = input.defaultEmail !== undefined
      ? normalizeOptionalText(input.defaultEmail)
      : existing?.default_email ?? null;
    const webhookEnabled = input.webhookEnabled ?? existing?.webhook_enabled ?? false;
    const webhookUrl = input.webhookUrl !== undefined
      ? normalizeOptionalText(input.webhookUrl)
      : existing?.webhook_url ?? null;
    const signingSecret = input.signingSecret !== undefined
      ? normalizeOptionalText(input.signingSecret)
      : input.rotateSigningSecret
        ? generateSecret()
        : webhookEnabled && webhookUrl && !existing?.signing_secret
          ? generateSecret()
          : existing?.signing_secret ?? null;

    const [row] = await queryRows<HumanContactSettingsRow>(
      this.input.database,
      `INSERT INTO ee_contact_settings (
         workspace_id,
         enabled,
         email_enabled,
         default_email,
         webhook_enabled,
         webhook_url,
         signing_secret
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id)
       DO UPDATE SET
         enabled = EXCLUDED.enabled,
         email_enabled = EXCLUDED.email_enabled,
         default_email = EXCLUDED.default_email,
         webhook_enabled = EXCLUDED.webhook_enabled,
         webhook_url = EXCLUDED.webhook_url,
         signing_secret = EXCLUDED.signing_secret,
         updated_at = NOW()
       RETURNING workspace_id, enabled, email_enabled, default_email, webhook_enabled, webhook_url, signing_secret, updated_at`,
      [input.workspaceId, input.enabled, emailEnabled, defaultEmail, webhookEnabled, webhookUrl, signingSecret],
    );

    await this.input.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "human_contact.settings_updated",
      eventStatus: "success",
      metadata: {
        enabled: input.enabled,
        emailConfigured: emailEnabled && Boolean(defaultEmail),
        webhookConfigured: webhookEnabled && Boolean(webhookUrl),
        signingSecretConfigured: Boolean(signingSecret),
        secretRotated: Boolean(input.rotateSigningSecret || input.signingSecret),
      },
    });

    return mapSettings(row);
  }

  async evaluateChatAction(input: {
    workspaceId: string;
    assistantMessageId: string;
    query: string;
    answer: string;
    answerOutcome: string;
  }): Promise<ChatActionSuggestion | null> {
    const settings = await this.findSettings(input.workspaceId);
    if (!settings.configured) {
      return null;
    }

    const deterministic = this.resolveDeterministicTrigger(input.query, input.answerOutcome);
    const trigger = deterministic ?? await this.classifyEscalation(input.query, input.answer);
    if (!trigger) {
      return null;
    }

    return {
      text: "Talk to a human",
      kind: "contact_human",
      action: {
        kind: "contact_human",
        payload: {
          triggerSource: trigger.source,
          triggerReason: trigger.reason,
          assistantMessageId: input.assistantMessageId,
        },
      },
    };
  }

  async evaluate(input: Parameters<ChatActionProvider["evaluate"]>[0]): Promise<ChatActionSuggestion | null> {
    return this.evaluateChatAction(input);
  }

  async getPublicSessionActions(input: { workspaceId: string }): Promise<Record<string, unknown> | null> {
    const settings = await this.findSettings(input.workspaceId);
    return {
      contact: {
        enabled: settings.enabled,
        configured: settings.configured,
      },
    };
  }

  async revealSigningSecret(input: { workspaceId: string }) {
    const row = await this.findSettingsRow(input.workspaceId);
    return {
      signingSecret: row?.signing_secret ?? null,
    };
  }

  async draft(input: {
    workspaceId: string;
    accountId?: string | null;
    conversationId: string;
    assistantMessageId?: string | null;
    anonymousSessionId?: string | null;
    defaultEmail?: string | null;
    sourceChannel?: string | null;
    sourceOrigin?: string | null;
  }) {
    await this.requireConfigured(input.workspaceId);
    await this.ensureConversationAccess(input);
    const messages = await this.input.messageRepository.listRecentByConversationId(input.workspaceId, input.conversationId, 12);
    return this.buildFallbackDraft(messages);
  }

  async submit(input: {
    workspaceId: string;
    accountId?: string | null;
    conversationId: string;
    assistantMessageId?: string | null;
    anonymousSessionId?: string | null;
    email: string;
    message: string;
    triggerSource: string;
    triggerReason?: string | null;
    sourceChannel?: string | null;
    sourceOrigin?: string | null;
  }) {
    await this.requireConfigured(input.workspaceId);
    await this.ensureConversationAccess(input);
    await this.input.abuseControlService.enforce({
      scope: "human_contact.submit",
      subjectKey: input.anonymousSessionId
        ? `${input.workspaceId}:anonymous:${input.anonymousSessionId}`
        : `${input.workspaceId}:account:${input.accountId ?? input.email}`,
      limit: input.anonymousSessionId ? PUBLIC_CONTACT_LIMIT : AUTHENTICATED_CONTACT_LIMIT,
      windowMs: CONTACT_RATE_LIMIT_WINDOW_MS,
      blockMs: CONTACT_RATE_LIMIT_WINDOW_MS,
    });

    const requestId = randomUUID();
    const summary = "";
    const assistantMessageId = await this.resolveAssistantMessageId({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      assistantMessageId: input.assistantMessageId,
    });

    await queryRows(
      this.input.database,
      `INSERT INTO ee_contact_requests (
         id,
         account_id,
         workspace_id,
         conversation_id,
         assistant_message_id,
         source_channel,
         source_origin,
         user_email,
         message,
         generated_summary,
         trigger_source,
         trigger_reason,
         status,
         next_retry_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', NOW())`,
      [
        requestId,
        input.accountId ?? null,
        input.workspaceId,
        input.conversationId,
        assistantMessageId,
        input.sourceChannel ?? null,
        input.sourceOrigin ?? null,
        input.email,
        input.message,
        summary,
        input.triggerSource,
        input.triggerReason ?? null,
      ],
    );

    await this.input.auditService.record({
      accountId: input.accountId ?? null,
      workspaceId: input.workspaceId,
      eventType: "human_contact.request_received",
      eventStatus: "success",
      metadata: {
        requestId,
        conversationId: input.conversationId,
        sourceChannel: input.sourceChannel ?? null,
        triggerSource: input.triggerSource,
      },
    });

    void this.processDueDeliveries(1).catch(() => undefined);
    return { requestId };
  }

  async processDueDeliveries(limit = 25): Promise<number> {
    const rows = await queryRows<HumanContactRequestRow>(
      this.input.database,
      `UPDATE ee_contact_requests
       SET status = 'delivering',
           updated_at = NOW()
       WHERE id IN (
         SELECT id
         FROM ee_contact_requests
         WHERE status = 'pending'
           AND next_retry_at <= NOW()
           AND attempts < $1
         ORDER BY next_retry_at ASC, created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, account_id, workspace_id, conversation_id, assistant_message_id,
         source_channel, source_origin, user_email, message,
         trigger_source, trigger_reason, attempts, created_at`,
      [MAX_ATTEMPTS, limit],
    );

    for (const row of rows) {
      await this.deliver(row);
    }

    return rows.length;
  }

  private isChatGateway(value: unknown): value is ChatGateway {
    return Boolean(value && typeof value === "object" && "answer" in value && typeof (value as { answer?: unknown }).answer === "function");
  }

  private async findSettingsRow(workspaceId: string): Promise<HumanContactSettingsRow | null> {
    const [row] = await queryRows<HumanContactSettingsRow>(
      this.input.database,
      `SELECT workspace_id, enabled, email_enabled, default_email, webhook_enabled, webhook_url, signing_secret, updated_at
       FROM ee_contact_settings
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    return row ?? null;
  }

  private async findSettings(workspaceId: string) {
    return mapSettings(await this.findSettingsRow(workspaceId));
  }

  private async requireConfigured(workspaceId: string): Promise<HumanContactSettingsRow> {
    const row = await this.findSettingsRow(workspaceId);
    const hasEmailDelivery = Boolean(row?.email_enabled && row.default_email);
    const hasWebhookDelivery = Boolean(row?.webhook_enabled && row.webhook_url && row.signing_secret);
    if (!row?.enabled || (!hasEmailDelivery && !hasWebhookDelivery)) {
      throw {
        statusCode: 503,
        code: "service_unavailable",
        message: "Talk to a human is not available for this workspace.",
      };
    }
    return row;
  }

  private resolveDeterministicTrigger(query: string, answerOutcome: string): { source: string; reason: string } | null {
    if (answerOutcome === "no_context_refusal") {
      return { source: "no_context_refusal", reason: "The assistant could not find enough grounded context." };
    }
    if (answerOutcome === "grounded_degraded_unsupported_segments") {
      return { source: "grounded_degraded_unsupported_segments", reason: "The assistant answer contained unsupported grounded segments." };
    }
    if (isExplicitHumanRequest(query)) {
      return { source: "explicit_user_request", reason: "The user asked to contact a person." };
    }
    return null;
  }

  private async classifyEscalation(query: string, answer: string): Promise<{ source: string; reason: string } | null> {
    if (!this.chatGateway) {
      return null;
    }
    try {
      const response = await this.chatGateway.answer({
        query,
        history: [],
        prompt: [
          "Decide whether the user should be offered a human follow-up action.",
          "Return compact JSON only: {\"shouldSuggest\": boolean, \"reason\": string}.",
          "Suggest only for unresolved support, account, pricing, safety, sales, or operational issues that a person should handle.",
          `User message: ${query.slice(0, 1000)}`,
          `Assistant answer: ${answer.slice(0, 1600)}`,
        ].join("\n"),
      });
      if (!parseClassifierDecision(response)) {
        return null;
      }
      return { source: "llm_classifier", reason: "The bounded classifier recommended human follow-up." };
    } catch {
      return null;
    }
  }

  private async ensureConversationAccess(input: {
    workspaceId: string;
    conversationId: string;
    anonymousSessionId?: string | null;
  }) {
    const conversation = input.anonymousSessionId
      ? await this.input.conversationRepository.findByIdAndAnonymousSession(
          input.conversationId,
          input.workspaceId,
          input.anonymousSessionId,
        )
      : await this.input.conversationRepository.findByIdAndWorkspaceId(input.conversationId, input.workspaceId);
    if (!conversation) {
      throw {
        statusCode: 404,
        code: "not_found",
        message: "Conversation not found",
      };
    }
  }

  private async resolveAssistantMessageId(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId?: string | null;
  }): Promise<string | null> {
    if (!input.assistantMessageId) {
      return null;
    }

    const [row] = await queryRows<{ id: string }>(
      this.input.database,
      `SELECT id
       FROM messages
       WHERE id = $1
         AND workspace_id = $2
         AND conversation_id = $3
         AND role = 'assistant'
       LIMIT 1`,
      [input.assistantMessageId, input.workspaceId, input.conversationId],
    );

    return row?.id ?? null;
  }

  private buildFallbackDraft(
    messages: Array<{ role: string; content: string }>,
  ): { draftMessage: string } {
    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content.trim();
    const issue = latestUserMessage || "I need help with this conversation.";

    return {
      draftMessage: `Hi, I would like a person to follow up on this request:\n\n${issue}`.slice(0, 6000),
    };
  }

  private async deliver(row: HumanContactRequestRow): Promise<void> {
    const settings = await this.requireConfigured(row.workspace_id);
    const payload = {
      requestId: row.id,
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      assistantMessageId: row.assistant_message_id,
      sourceChannel: row.source_channel,
      sourceOrigin: row.source_origin,
      email: row.user_email,
      message: row.message,
      triggerSource: row.trigger_source,
      triggerReason: row.trigger_reason,
      createdAt: serializeDate(row.created_at),
    };
    const errors: string[] = [];

    if (settings.email_enabled && settings.default_email) {
      try {
        await this.input.emailService.send({
          to: settings.default_email,
          subject: `Radioso talk to a human request from ${row.user_email}`,
          text: [
            "A visitor asked to talk to a human.",
            "",
            `From: ${row.user_email}`,
            `Workspace: ${row.workspace_id}`,
            `Conversation: ${row.conversation_id}`,
            `Request: ${row.id}`,
            "",
            "Message:",
            row.message,
          ].join("\n"),
          metadata: {
            kind: "human_contact_request",
            requestId: row.id,
            workspaceId: row.workspace_id,
          },
        });
      } catch (error) {
        errors.push(`Email: ${error instanceof Error ? error.message : "delivery failed"}`);
      }
    }

    if (settings.webhook_enabled && settings.webhook_url && settings.signing_secret) {
      const body = JSON.stringify(payload);
      const signature = createHmac("sha256", settings.signing_secret).update(body).digest("hex");
      try {
        const response = await (this.input.webhookFetch ?? fetch)(settings.webhook_url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-radioso-signature": `sha256=${signature}`,
            "x-radioso-event": "human_contact.requested",
          },
          body,
        });
        if (!response.ok) {
          errors.push(`Webhook: HTTP ${response.status}`);
        }
      } catch (error) {
        errors.push(`Webhook: ${error instanceof Error ? error.message : "delivery failed"}`);
      }
    }

    if (errors.length === 0) {
      await queryRows(
        this.input.database,
        `UPDATE ee_contact_requests
         SET status = 'delivered',
             attempts = attempts + 1,
             final_delivery_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
      return;
    }

    await this.recordDeliveryFailure(row, errors.join("; "));
  }

  private async recordDeliveryFailure(row: HumanContactRequestRow, reason: string): Promise<void> {
    const nextAttempt = row.attempts + 1;
    const terminal = nextAttempt >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(60 * 60, 2 ** Math.max(nextAttempt - 1, 0) * 30);
    await queryRows(
      this.input.database,
      `UPDATE ee_contact_requests
       SET status = $2,
           attempts = attempts + 1,
           next_retry_at = CASE WHEN $2 = 'pending' THEN NOW() + ($3::text || ' seconds')::interval ELSE next_retry_at END,
           final_delivery_error = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, terminal ? "failed" : "pending", delaySeconds, reason.slice(0, 1000)],
    );
    this.input.logger.warn?.(
      {
        requestId: row.id,
        workspaceId: row.workspace_id,
        attempt: nextAttempt,
        terminal,
        error: reason.slice(0, 200),
      },
      "Human contact webhook delivery failed",
    );
  }
}
