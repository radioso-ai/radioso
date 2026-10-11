import { transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  NotificationDeliveryAdmission,
  NotificationDeliveryCapReason,
  NotificationDeliveryOutcomeRepositoryPort,
} from "../../modules/operatorNotifications/notificationDeliveryAdmission.js";

type Outcome = "allowed" | NotificationDeliveryCapReason;

const mapOutcome = (outcome: Outcome, newlyRecorded: boolean): NotificationDeliveryAdmission & { newlyRecorded: boolean } => ({
  dispatchAllowed: outcome !== "conversation_dispatch_cap",
  emailAllowed: outcome === "allowed",
  reason: outcome === "allowed" ? null : outcome,
  newlyRecorded,
});

export class NotificationDeliveryOutcomeRepository implements NotificationDeliveryOutcomeRepositoryPort {
  constructor(private readonly db: Db) {}

  async reserve(input: {
    requestId: string;
    recipientDigest: string;
    workspaceId: string;
    conversationId: string;
    usageDate: Date;
    requestedEmailCount: number;
    dailyEmailLimit: number;
    conversationDispatchLimit: number;
  }): Promise<NotificationDeliveryAdmission & { newlyRecorded: boolean }> {
    return this.db.transaction().execute(async (transaction) => {
      const usageDateKey = input.usageDate.toISOString().slice(0, 10);
      await transactionAdvisoryLock(`notification-delivery:workspace:${input.workspaceId}:${usageDateKey}`).execute(transaction);
      await transactionAdvisoryLock(`notification-delivery:conversation:${input.workspaceId}:${input.conversationId}`).execute(transaction);

      const existing = await transaction
        .selectFrom("notification_delivery_outcomes")
        .select("outcome")
        .where("request_id", "=", input.requestId)
        .where("recipient_digest", "=", input.recipientDigest)
        .executeTakeFirst();
      if (existing) {
        return mapOutcome(existing.outcome as Outcome, false);
      }

      const conversationCount = await transaction
        .selectFrom("notification_delivery_outcomes")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("workspace_id", "=", input.workspaceId)
        .where("conversation_id", "=", input.conversationId)
        .where("outcome", "!=", "conversation_dispatch_cap")
        .executeTakeFirstOrThrow();

      let outcome: Outcome;
      let reservedEmailCount = 0;
      if (Number(conversationCount.count) >= input.conversationDispatchLimit) {
        outcome = "conversation_dispatch_cap";
      } else {
        const dailyUsage = await transaction
          .selectFrom("notification_delivery_outcomes")
          .select((expression) => expression.fn.coalesce(expression.fn.sum<number>("reserved_email_count"), expression.val(0)).as("count"))
          .where("workspace_id", "=", input.workspaceId)
          .where("usage_date", "=", input.usageDate)
          .executeTakeFirstOrThrow();
        if (Number(dailyUsage.count) + input.requestedEmailCount > input.dailyEmailLimit) {
          outcome = "workspace_daily_email_cap";
        } else {
          outcome = "allowed";
          reservedEmailCount = input.requestedEmailCount;
        }
      }

      await transaction.insertInto("notification_delivery_outcomes").values({
        request_id: input.requestId,
        recipient_digest: input.recipientDigest,
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        usage_date: input.usageDate,
        requested_email_count: input.requestedEmailCount,
        reserved_email_count: reservedEmailCount,
        outcome,
        daily_email_limit: input.dailyEmailLimit,
        conversation_dispatch_limit: input.conversationDispatchLimit,
      }).execute();

      return mapOutcome(outcome, true);
    });
  }
}
