import type { Request } from "express";
import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { ResendWebhookVerifier } from "../../../modules/mail/public.js";
import { recordNotificationSuppression } from "../../../modules/operatorNotifications/public.js";

type Dependencies = Pick<
  AppDependencies,
  "emailChannel" | "env" | "logger" | "metricsRegistry" | "notificationRecipientSuppressions"
>;

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const headersOf = (req: Request): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]));

/**
 * Keeps the established Resend webhook useful for notification suppression when the optional
 * inbound email channel is off. When the channel is on its connector owns this path and also
 * persists inbound and delivery events.
 */
export const createNotificationDeliveryWebhookRoutes = (dependencies: Dependencies): Router => {
  const router = Router();
  const secret = dependencies.env.EMAIL_CHANNEL_WEBHOOK_SECRET;
  const verifier = secret
    ? new ResendWebhookVerifier({
        current: secret,
        previous: dependencies.env.EMAIL_CHANNEL_WEBHOOK_SECRET_PREVIOUS ?? null,
      })
    : null;

  router.post("/webhook", async (req: RawBodyRequest, res, next) => {
    if (dependencies.emailChannel || !verifier) {
      next();
      return;
    }
    if (!req.rawBody) {
      res.sendStatus(400);
      return;
    }

    const verified = verifier.verify({ rawBody: req.rawBody, headers: headersOf(req), now: new Date() });
    if (!verified.ok) {
      dependencies.logger.warn({
        event: "notification_delivery_webhook_rejected",
        provider: "resend",
        reason: verified.reason,
      }, "Notification delivery webhook rejected");
      res.sendStatus(verified.reason === "malformed_payload" ? 400 : 401);
      return;
    }

    const event = verified.event;
    if (event.kind !== "delivery_status") {
      res.sendStatus(200);
      return;
    }
    try {
      await recordNotificationSuppression({
        event,
        provider: "resend",
        store: dependencies.notificationRecipientSuppressions,
        logger: dependencies.logger,
        metrics: dependencies.metricsRegistry,
      });
      res.sendStatus(200);
    } catch {
      res.sendStatus(503);
    }
  });

  return router;
};
