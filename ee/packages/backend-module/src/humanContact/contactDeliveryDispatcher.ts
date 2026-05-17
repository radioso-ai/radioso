import { createHmac } from "node:crypto";

import type { EmailService, Logger } from "./humanContactTypes.js";
import {
  HUMAN_CONTACT_SKILL_NAME,
  MAX_ATTEMPTS,
  serializeDate,
} from "./humanContactTypes.js";
import { buildContactStage, replaceContactTraceStage } from "./contactActivityTrace.js";
import type { HumanContactSettingsService } from "./contactSettingsService.js";
import type {
  SkillSubmissionRepository,
  SkillSubmissionRow,
} from "../skillSubmissions/skillSubmissionRepository.js";

export class HumanContactDeliveryDispatcher {
  constructor(private readonly input: {
    submissions: SkillSubmissionRepository;
    logger: Logger;
    settingsService: HumanContactSettingsService;
    emailService: EmailService;
    webhookFetch?: typeof fetch;
  }) {}

  async processDueDeliveries(limit = 25): Promise<number> {
    const rows = await this.input.submissions.claimDueDeliveries({
      maxAttempts: MAX_ATTEMPTS,
      limit,
      skillName: HUMAN_CONTACT_SKILL_NAME,
    });
    for (const row of rows) {
      await this.deliver(row);
    }
    return rows.length;
  }

  private contactEmail(row: SkillSubmissionRow): string {
    if (typeof row.fields.email === "string" && row.fields.email.trim()) {
      return row.fields.email;
    }
    return row.subject_identity ?? "visitor";
  }

  private contactMessage(row: SkillSubmissionRow): string {
    return typeof row.fields.message === "string" ? row.fields.message : "";
  }

  private async deliver(row: SkillSubmissionRow): Promise<void> {
    const settings = await this.input.settingsService.requireConfigured(row.workspace_id);
    const email = this.contactEmail(row);
    const message = this.contactMessage(row);
    const payload = {
      requestId: row.id,
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      assistantMessageId: row.assistant_message_id,
      sourceChannel: row.source_channel,
      sourceOrigin: row.source_origin,
      email,
      message,
      triggerSource: row.trigger_source,
      triggerReason: row.trigger_reason,
      createdAt: serializeDate(row.created_at),
    };
    const errors: string[] = [];

    if (settings.email_enabled && settings.default_email) {
      try {
        await this.input.emailService.send({
          to: settings.default_email,
          subject: `Radioso contact request from ${email}`,
          text: [
            "A visitor submitted a contact request.",
            "",
            `From: ${email}`,
            `Workspace: ${row.workspace_id}`,
            `Conversation: ${row.conversation_id}`,
            `Request: ${row.id}`,
            "",
            "Message:",
            message,
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
      await this.input.submissions.markDelivered(row.id, activityTrace ?? null);
      return;
    }

    await this.recordDeliveryFailure(row, errors.join("; "));
  }

  private async recordDeliveryFailure(row: SkillSubmissionRow, reason: string): Promise<void> {
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
    await this.input.submissions.recordFailure({
      id: row.id,
      nextStatus: terminal ? "failed" : "pending",
      nextRetryDelaySeconds: delaySeconds,
      reason: reason.slice(0, 1000),
      activityTrace: activityTrace ?? null,
    });
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
