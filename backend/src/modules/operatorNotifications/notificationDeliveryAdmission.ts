import type { AuditService } from "../audit/contracts/index.js";
import {
  resolveNotificationEmailDailyLimit,
  type UsageLimitPolicy,
} from "../../shared/domain/usageLimitPolicy.js";

const NOTIFICATION_DISPATCHES_PER_CONVERSATION = 5;

export type NotificationDeliveryCapReason =
  | "workspace_daily_email_cap"
  | "conversation_dispatch_cap";

export interface NotificationDeliveryAdmission {
  dispatchAllowed: boolean;
  emailAllowed: boolean;
  reason: NotificationDeliveryCapReason | "missing_context" | null;
}

export interface NotificationDeliveryOutcomeRepositoryPort {
  reserve(input: {
    requestId: string;
    workspaceId: string;
    conversationId: string;
    usageDate: Date;
    requestedEmailCount: number;
    dailyEmailLimit: number;
    conversationDispatchLimit: number;
  }): Promise<NotificationDeliveryAdmission & { newlyRecorded: boolean }>;
}

export interface NotificationDeliveryAdmissionPort {
  admit(input: {
    requestId: string;
    workspaceId: string | null;
    accountId: string | null;
    conversationId: string | null;
    requestedEmailCount: number;
  }): Promise<NotificationDeliveryAdmission>;
}

interface AdmissionLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

const utcDate = (date: Date): Date => new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);

export class NotificationDeliveryAdmissionService implements NotificationDeliveryAdmissionPort {
  constructor(
    private readonly outcomes: NotificationDeliveryOutcomeRepositoryPort,
    private readonly usageLimits: UsageLimitPolicy,
    private readonly audit?: Pick<AuditService, "record">,
    private readonly logger?: AdmissionLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async admit(input: {
    requestId: string;
    workspaceId: string | null;
    accountId: string | null;
    conversationId: string | null;
    requestedEmailCount: number;
  }): Promise<NotificationDeliveryAdmission> {
    if (!input.workspaceId || !input.conversationId) {
      this.logger?.warn(
        { requestId: input.requestId, hasWorkspaceId: Boolean(input.workspaceId), hasConversationId: Boolean(input.conversationId) },
        "notification_delivery_missing_context",
      );
      return { dispatchAllowed: false, emailAllowed: false, reason: "missing_context" };
    }

    const dailyEmailLimit = await resolveNotificationEmailDailyLimit(this.usageLimits, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
    });
    const outcome = await this.outcomes.reserve({
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      usageDate: utcDate(this.now()),
      requestedEmailCount: Math.max(0, Math.floor(input.requestedEmailCount)),
      dailyEmailLimit,
      conversationDispatchLimit: NOTIFICATION_DISPATCHES_PER_CONVERSATION,
    });

    if (outcome.reason) {
      const metadata = {
        requestId: input.requestId,
        conversationId: input.conversationId,
        reason: outcome.reason,
        requestedEmailCount: input.requestedEmailCount,
        dailyEmailLimit,
        conversationDispatchLimit: NOTIFICATION_DISPATCHES_PER_CONVERSATION,
      };
      if (outcome.newlyRecorded) {
        this.logger?.warn(metadata, "notification_delivery_skipped");
        await this.audit?.record({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: "operator_notification.delivery_skipped",
          eventStatus: "success",
          metadata,
        });
      }
    }

    return {
      dispatchAllowed: outcome.dispatchAllowed,
      emailAllowed: outcome.emailAllowed,
      reason: outcome.reason,
    };
  }
}
