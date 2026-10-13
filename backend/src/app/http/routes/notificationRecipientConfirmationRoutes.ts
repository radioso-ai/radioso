import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { NotificationRecipientTokenSigner } from "../../../modules/operatorNotifications/public.js";
import { badRequest } from "../../../shared/domain/errors.js";

type Dependencies = Pick<AppDependencies, "env" | "notificationRecipientPolicy">;

const tokenSchema = z.string().min(1).max(4096);

const tokenOf = (value: unknown): string => {
  const parsed = tokenSchema.safeParse(value);
  if (!parsed.success) throw badRequest("Invalid notification recipient token");
  return parsed.data;
};

const confirmationPage = (message: string, revokeUrl?: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Radioso notification preferences</title></head><body><main><h1>${message}</h1><p>You can close this page.</p>${revokeUrl ? `<p><a href="${revokeUrl}">Stop sending me these notifications</a></p>` : ""}</main></body></html>`;

export const createNotificationRecipientConfirmationRoutes = (dependencies: Dependencies): Router => {
  const router = Router();
  const signer = new NotificationRecipientTokenSigner(dependencies.env.SESSION_COOKIE_SECRET);

  router.get("/notification-recipient-confirmations/confirm", async (req, res, next) => {
    try {
      const recipientId = signer.verify(tokenOf(req.query.token), "confirm");
      if (!recipientId) throw badRequest("Invalid notification recipient token");
      await dependencies.notificationRecipientPolicy.confirm(recipientId);
      res.setHeader("Cache-Control", "no-store");
      const revokeToken = signer.sign(recipientId, "revoke");
      res.status(200).type("html").send(confirmationPage(
        "Notifications confirmed",
        `/api/v1/notification-recipient-confirmations/revoke?token=${encodeURIComponent(revokeToken)}`,
      ));
    } catch (error) {
      next(error);
    }
  });

  const revoke = async (rawToken: unknown): Promise<void> => {
    const recipientId = signer.verify(tokenOf(rawToken), "revoke");
    if (!recipientId) throw badRequest("Invalid notification recipient token");
    await dependencies.notificationRecipientPolicy.revoke(recipientId);
  };

  router.get("/notification-recipient-confirmations/revoke", async (req, res, next) => {
    try {
      await revoke(req.query.token);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).type("html").send(confirmationPage("Notifications stopped"));
    } catch (error) {
      next(error);
    }
  });

  router.post("/notification-recipient-confirmations/revoke", async (req, res, next) => {
    try {
      await revoke(req.query.token);
      res.setHeader("Cache-Control", "no-store");
      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
