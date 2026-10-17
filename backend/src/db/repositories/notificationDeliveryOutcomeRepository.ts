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
        .select(["outcome", "reserved_email_count"])
        .where("request_id", "=", input.requestId)
        .where("recipient_digest", "=", input.recipientDigest)
        .executeTakeFirst();
      if (existing) {
        // A replay of the same list can email more of it once addresses have confirmed; those extra
        // emails are reserved now, or the replay's email is capped when the day cannot take them.
        const extraEmails = input.requestedEmailCount - existing.reserved_email_count;
        if (existing.outcome !== "allowed" || extraEmails <= 0) {
          return mapOutcome(existing.outcome as Outcome, false);
        }
        if (await this.dailyEmailsUsed(transaction, input) + extraEmails > input.dailyEmailLimit) {
          return mapOutcome("workspace_daily_email_cap", false);
        }
        await transaction.updateTable("notification_delivery_outcomes")
          .set({ reserved_email_count: input.requestedEmailCount, requested_email_count: input.requestedEmailCount })
          .where("request_id", "=", input.requestId)
          .where("recipient_digest", "=", input.recipientDigest)
          .execute();
        return mapOutcome("allowed", false);
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
        if (await this.dailyEmailsUsed(transaction, input) + input.requestedEmailCount > input.dailyEmailLimit) {
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

  private async dailyEmailsUsed(db: Db, input: { workspaceId: string; usageDate: Date }): Promise<number> {
    const usage = await db
      .selectFrom("notification_delivery_outcomes")
      .select((expression) => expression.fn.coalesce(expression.fn.sum<number>("reserved_email_count"), expression.val(0)).as("count"))
      .where("workspace_id", "=", input.workspaceId)
      .where("usage_date", "=", input.usageDate)
      .executeTakeFirstOrThrow();
    return Number(usage.count);
  }

  async readDailyUsage(input: { workspaceId: string; usageDate: Date }): Promise<{ reservedEmails: number; cappedRequests: number }> {
    const usage = await this.db
      .selectFrom("notification_delivery_outcomes")
      .select((expression) => [
        expression.fn.coalesce(expression.fn.sum<number>("reserved_email_count"), expression.val(0)).as("reservedEmails"),
        expression.fn.countAll<number>().filterWhere("outcome", "=", "workspace_daily_email_cap").as("cappedRequests"),
      ])
      .where("workspace_id", "=", input.workspaceId)
      .where("usage_date", "=", input.usageDate)
      .executeTakeFirstOrThrow();
    return { reservedEmails: Number(usage.reservedEmails), cappedRequests: Number(usage.cappedRequests) };
  }
}
