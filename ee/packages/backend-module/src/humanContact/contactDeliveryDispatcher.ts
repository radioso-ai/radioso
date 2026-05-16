import { createHmac } from "node:crypto";

import type { EmailService, HumanContactRequestRow, Logger } from "./humanContactTypes.js";
import {
  MAX_ATTEMPTS,
  queryRows,
  serializeDate,
} from "./humanContactTypes.js";
import { buildContactStage, replaceContactTraceStage } from "./contactActivityTrace.js";
import type { HumanContactSettingsService } from "./contactSettingsService.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";

export class HumanContactDeliveryDispatcher {
  constructor(private readonly input: {
    database: UsageLimitDatabasePort;
    logger: Logger;
    settingsService: HumanContactSettingsService;
    emailService: EmailService;
    webhookFetch?: typeof fetch;
  }) {}

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
         trigger_source, trigger_reason, attempts, activity_trace, created_at`,
      [MAX_ATTEMPTS, limit],
    );

    for (const row of rows) {
      await this.deliver(row);
    }

    return rows.length;
  }

  private async deliver(row: HumanContactRequestRow): Promise<void> {
    const settings = await this.input.settingsService.requireConfigured(row.workspace_id);
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
          subject: `Radioso contact request from ${row.user_email}`,
          text: [
            "A visitor submitted a contact request.",
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
      const activityTrace = replaceContactTraceStage(
        row.activity_trace,
        buildContactStage("delivery_dispatch", "delivery_dispatch", "Delivery dispatch", "applied", {
          outputs: {
            status: "delivered",
            emailDeliveryAttempted: Boolean(settings.email_enabled && settings.default_email),
            webhookDeliveryAttempted: Boolean(settings.webhook_enabled && settings.webhook_url),
          },
          metrics: {
            attempt: row.attempts + 1,
          },
        }),
        "delivered",
        "success",
      );
      await queryRows(
        this.input.database,
        `UPDATE ee_contact_requests
         SET status = 'delivered',
             attempts = attempts + 1,
             final_delivery_error = NULL,
             activity_trace = COALESCE($2::jsonb, activity_trace),
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, activityTrace],
      );
      return;
    }

    await this.recordDeliveryFailure(row, errors.join("; "));
  }

  private async recordDeliveryFailure(row: HumanContactRequestRow, reason: string): Promise<void> {
    const nextAttempt = row.attempts + 1;
    const terminal = nextAttempt >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(60 * 60, 2 ** Math.max(nextAttempt - 1, 0) * 30);
    const activityTrace = replaceContactTraceStage(
      row.activity_trace,
      buildContactStage("delivery_dispatch", "delivery_dispatch", "Delivery dispatch", terminal ? "failed" : "fallback", {
        reason,
        outputs: {
          status: terminal ? "failed" : "pending",
          retryScheduled: !terminal,
          finalDeliveryError: reason.slice(0, 1000),
        },
        metrics: {
          attempt: nextAttempt,
        },
      }),
      terminal ? "delivery_failed" : "delivery_retry_scheduled",
      terminal ? "failed" : "fallback",
    );
    await queryRows(
      this.input.database,
      `UPDATE ee_contact_requests
       SET status = $2,
           attempts = attempts + 1,
           next_retry_at = CASE WHEN $2 = 'pending' THEN NOW() + ($3::text || ' seconds')::interval ELSE next_retry_at END,
           final_delivery_error = $4,
           activity_trace = COALESCE($5::jsonb, activity_trace),
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, terminal ? "failed" : "pending", delaySeconds, reason.slice(0, 1000), activityTrace],
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
