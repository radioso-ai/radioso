import type {
  NotificationRecipientStateStore,
  UndeliveredAlertClaim,
  UndeliveredRecipientAlertStore,
} from "../../modules/operatorNotifications/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * The throttle for the "notices skip this address" alert: a timestamp on the address's own
 * confirmation row, claimed with one conditional UPDATE, so two workers that skip the same address
 * at once cannot both alert. Who the alert reaches is `NotificationAdministratorRepository`'s.
 */
export class UndeliveredRecipientAlertRepository implements UndeliveredRecipientAlertStore {
  constructor(
    private readonly db: Db,
    private readonly states: Pick<NotificationRecipientStateStore, "ensure">,
  ) {}

  async claim(input: { workspaceId: string; email: string; now: Date; windowMs: number }): Promise<UndeliveredAlertClaim | null> {
    // An address that never got a confirmation row (a suppressed one, say) gets one to carry the throttle.
    const { recipientId } = await this.states.ensure(input.workspaceId, input.email);
    const windowStart = new Date(input.now.getTime() - input.windowMs);
    const claimed = await this.db
      .updateTable("notification_recipient_confirmations")
      .set({ undelivered_alert_sent_at: input.now })
      .where("id", "=", recipientId)
      .where((eb) => eb.or([
        eb("undelivered_alert_sent_at", "is", null),
        eb("undelivered_alert_sent_at", "<=", windowStart),
      ]))
      .returning("id")
      .executeTakeFirst();
    return claimed ? { recipientId, claimedAt: input.now } : null;
  }

  async release(claim: UndeliveredAlertClaim): Promise<void> {
    // A claim is only taken when the last alert is outside the window, so clearing it restores
    // exactly what the throttle saw before.
    await this.db
      .updateTable("notification_recipient_confirmations")
      .set({ undelivered_alert_sent_at: null })
      .where("id", "=", claim.recipientId)
      .where("undelivered_alert_sent_at", "=", claim.claimedAt)
      .execute();
  }
}
