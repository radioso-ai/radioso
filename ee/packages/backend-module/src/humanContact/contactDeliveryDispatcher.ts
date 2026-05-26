import { createHmac } from "node:crypto";

import type {
  Logger,
  MailService,
  MessageRepository,
  WorkspaceContactInfo,
  WorkspaceContactInfoRepository,
} from "./humanContactTypes.js";
import {
  HUMAN_CONTACT_SKILL_NAME,
  MAX_ATTEMPTS,
  normalizeEmailRecipients,
  serializeDate,
} from "./humanContactTypes.js";
import { buildContactStage, replaceContactTraceStage } from "./contactActivityTrace.js";
import { renderHumanContactRequestEmail } from "./contactRequestEmailTemplate.js";
import type { HumanContactSettingsService } from "./contactSettingsService.js";
import type {
  SkillSubmissionRepository,
  SkillSubmissionRow,
} from "../skillSubmissions/skillSubmissionRepository.js";

const CONVERSATION_TURNS_LIMIT = 6;

export class HumanContactDeliveryDispatcher {
  constructor(private readonly input: {
    submissions: SkillSubmissionRepository;
    logger: Logger;
    settingsService: HumanContactSettingsService;
    mailService: MailService;
    messageRepository?: MessageRepository;
    workspaceContactInfoRepository?: WorkspaceContactInfoRepository;
    dashboardBaseUrl?: string | null;
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
    // Last-resort delivery label for malformed legacy rows; validated submissions should carry email fields.
    return row.subject_identity ?? "visitor";
  }

  private contactMessage(row: SkillSubmissionRow): string {
    return typeof row.fields.message === "string" ? row.fields.message : "";
  }

  private async loadRecentTurns(workspaceId: string, conversationId: string): Promise<Array<{
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: Date;
  }>> {
    const repository = this.input.messageRepository;
    if (!repository) {
      return [];
    }
    try {
      return await repository.listRecentByConversationId(workspaceId, conversationId, CONVERSATION_TURNS_LIMIT);
    } catch (error) {
      this.input.logger.warn?.(
        { workspaceId, conversationId, err: error instanceof Error ? error.message : String(error) },
        "Failed to load recent conversation for contact email",
      );
      return [];
    }
  }

  private async loadWorkspaceContactInfo(workspaceId: string): Promise<WorkspaceContactInfo | null> {
    const repository = this.input.workspaceContactInfoRepository;
    if (!repository) {
      return null;
    }
    try {
      return await repository.findById(workspaceId);
    } catch (error) {
      this.input.logger.warn?.(
        { workspaceId, err: error instanceof Error ? error.message : String(error) },
        "Failed to load workspace info for contact email",
      );
      return null;
    }
  }

  private buildDashboardUrl(workspace: WorkspaceContactInfo | null, requestId: string): string | null {
    const base = this.input.dashboardBaseUrl?.replace(/\/+$/, "");
    if (!base || !workspace) {
      return null;
    }
    const params = new URLSearchParams({
      filter: "contact",
      itemKind: "contact",
      itemId: requestId,
    });
    return `${base}/w/${encodeURIComponent(workspace.publicRouteKey)}/activity?${params.toString()}`;
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

    const emailRecipients = normalizeEmailRecipients(settings.default_emails ?? (settings.default_email ? [settings.default_email] : []));
    if (settings.email_enabled && emailRecipients.length > 0) {
      const [workspace, recentTurns] = await Promise.all([
        this.loadWorkspaceContactInfo(row.workspace_id),
        this.loadRecentTurns(row.workspace_id, row.conversation_id),
      ]);
      const dashboardUrl = this.buildDashboardUrl(workspace, row.id);
      for (const recipient of emailRecipients) {
        try {
          await this.input.mailService.send(renderHumanContactRequestEmail({
            to: recipient,
            visitorEmail: email,
            message,
            workspace: workspace
              ? { name: workspace.name, publicRouteKey: workspace.publicRouteKey }
              : null,
            sourceChannel: row.source_channel,
            createdAt: row.created_at,
            requestId: row.id,
            workspaceId: row.workspace_id,
            dashboardUrl,
            recentTurns,
          }));
        } catch (error) {
          errors.push(`Email[${recipient}]: ${error instanceof Error ? error.message : "delivery failed"}`);
        }
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
            emailDeliveryAttempted: Boolean(settings.email_enabled && emailRecipients.length > 0),
            emailRecipientCount: emailRecipients.length,
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
