import { randomUUID } from "node:crypto";

import type { ActivityTrace } from "../radiosoModuleTypes.js";
import type {
  AbuseControlService,
  AuditService,
  ConversationRepository,
  HumanContactRequestRow,
} from "./humanContactTypes.js";
import {
  AUTHENTICATED_CONTACT_LIMIT,
  CONTACT_RATE_LIMIT_WINDOW_MS,
  PUBLIC_CONTACT_LIMIT,
  normalizeIdempotencyKey,
  queryRows,
} from "./humanContactTypes.js";
import { buildContactStage, buildContactTrace } from "./contactActivityTrace.js";
import type { HumanContactSettingsService } from "./contactSettingsService.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";

export interface HumanContactSubmitInput {
  workspaceId: string;
  agentId?: string | null;
  accountId?: string | null;
  conversationId: string;
  assistantMessageId?: string | null;
  anonymousSessionId?: string | null;
  email: string;
  message: string;
  triggerSource: string;
  triggerReason?: string | null;
  idempotencyKey?: string | null;
  sourceChannel?: string | null;
  sourceOrigin?: string | null;
}

export class HumanContactRequestExecutor {
  constructor(private readonly input: {
    database: UsageLimitDatabasePort;
    settingsService: HumanContactSettingsService;
    conversationRepository: ConversationRepository;
    auditService: AuditService;
    abuseControlService: AbuseControlService;
    processDueDeliveries(limit?: number): Promise<number>;
  }) {}

  async submit(input: HumanContactSubmitInput) {
    await this.input.settingsService.requireConfigured(input.workspaceId);
    await this.ensureConversationAccess(input);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const existing = idempotencyKey
      ? await this.findRequestByIdempotencyKey(input.workspaceId, idempotencyKey)
      : null;
    if (existing) {
      return this.presentExistingSubmitResult(existing);
    }

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
    const activityTrace = buildContactTrace([
      buildContactStage("availability_check", "availability_check", "Availability check", "applied", {
        outputs: {
          configured: true,
        },
      }),
      buildContactStage("trigger_evaluation", "trigger_evaluation", "Trigger evaluation", "applied", {
        outputs: {
          triggerSource: input.triggerSource,
          triggerReason: input.triggerReason ?? null,
          idempotencyKey,
        },
      }),
      buildContactStage("request_submit", "request_submit", "Request submit", "applied", {
        outputs: {
          requestId,
          conversationId: input.conversationId,
          assistantMessageId,
          idempotencyKey,
          sourceChannel: input.sourceChannel ?? null,
        },
      }),
      buildContactStage("delivery_dispatch", "delivery_dispatch", "Delivery dispatch", "skipped", {
        reason: "Delivery is queued for background dispatch.",
        outputs: {
          status: "pending",
        },
      }),
      buildContactStage("audit_record", "audit_record", "Audit record", "applied", {
        outputs: {
          eventType: "human_contact.request_received",
        },
      }),
    ], "request_queued", "pending");

    const rows = await queryRows<HumanContactRequestRow>(
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
         idempotency_key,
         status,
         next_retry_at,
         activity_trace
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', NOW(), $14::jsonb)
       ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING id::text, account_id::text, workspace_id::text, conversation_id::text,
         assistant_message_id::text, source_channel, source_origin, user_email, message,
         trigger_source, trigger_reason, idempotency_key, attempts, activity_trace, created_at`,
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
        idempotencyKey,
        activityTrace,
      ],
    );
    const inserted = rows[0];
    if (!inserted) {
      const existingAfterConflict = idempotencyKey
        ? await this.findRequestByIdempotencyKey(input.workspaceId, idempotencyKey)
        : null;
      if (existingAfterConflict) {
        return this.presentExistingSubmitResult(existingAfterConflict);
      }
      throw new Error("Human contact request insert did not return a row.");
    }

    await this.input.auditService.record({
      accountId: input.accountId ?? null,
      workspaceId: input.workspaceId,
      eventType: "human_contact.request_received",
      eventStatus: "success",
      metadata: {
        requestId,
        conversationId: input.conversationId,
        idempotencyKey,
        sourceChannel: input.sourceChannel ?? null,
        triggerSource: input.triggerSource,
      },
    });

    void this.input.processDueDeliveries(1).catch(() => undefined);
    return { requestId, activityTrace, activitySummary: activityTrace.summary };
  }

  private async findRequestByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<HumanContactRequestRow | null> {
    const [row] = await queryRows<HumanContactRequestRow>(
      this.input.database,
      `SELECT id::text, account_id::text, workspace_id::text, conversation_id::text,
         assistant_message_id::text, source_channel, source_origin, user_email, message,
         trigger_source, trigger_reason, idempotency_key, attempts, activity_trace, created_at
       FROM ee_contact_requests
       WHERE workspace_id = $1
         AND idempotency_key = $2
       LIMIT 1`,
      [workspaceId, idempotencyKey],
    );
    return row ?? null;
  }

  private presentExistingSubmitResult(row: HumanContactRequestRow) {
    const activityTrace = row.activity_trace ?? buildContactTrace([
      buildContactStage("request_submit", "request_submit", "Request submit", "skipped", {
        reason: "An existing contact request matched the idempotency key.",
        outputs: {
          requestId: row.id,
          idempotencyKey: row.idempotency_key ?? null,
        },
      }),
    ], "request_already_queued", "pending");
    return {
      requestId: row.id,
      activityTrace,
      activitySummary: activityTrace.summary,
    };
  }

  private async ensureConversationAccess(input: {
    workspaceId: string;
    agentId?: string | null;
    conversationId: string;
    anonymousSessionId?: string | null;
  }) {
    if (input.agentId && input.anonymousSessionId) {
      const [conversation] = await queryRows<{ id: string }>(
        this.input.database,
        `SELECT id
         FROM conversations
         WHERE id = $1
           AND workspace_id = $2
           AND anonymous_session_id = $3
           AND agent_id = $4
         LIMIT 1`,
        [input.conversationId, input.workspaceId, input.anonymousSessionId, input.agentId],
      );
      if (!conversation) {
        throw {
          statusCode: 404,
          code: "not_found",
          message: "Conversation not found",
        };
      }
      return;
    }

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
}
