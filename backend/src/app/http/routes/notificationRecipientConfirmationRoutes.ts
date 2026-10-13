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

const confirmationPage = (message: string, action?: { url: string; label: string }): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Radioso notification preferences</title></head><body><main><h1>${message}</h1>${action ? `<form method="post" action="${action.url}"><button type="submit">${action.label}</button></form>` : "<p>You can close this page.</p>"}</main></body></html>`;

export const createNotificationRecipientConfirmationRoutes = (dependencies: Dependencies): Router => {
  const router = Router();
  const signer = new NotificationRecipientTokenSigner(dependencies.env.SESSION_COOKIE_SECRET);

  const signedAction = (rawToken: unknown, action: "confirm" | "revoke") => {
    const subject = signer.verify(tokenOf(rawToken), action);
    if (!subject) throw badRequest("Invalid notification recipient token");
    return subject;
  };

  const formUrl = (action: "confirm" | "revoke", token: string): string =>
    `/api/v1/notification-recipient-confirmations/${action}?token=${encodeURIComponent(token)}`;

  router.get("/notification-recipient-confirmations/confirm", async (req, res, next) => {
    try {
      signedAction(req.query.token, "confirm");
      res.setHeader("Cache-Control", "no-store");
      res.status(200).type("html").send(confirmationPage(
        "Confirm notification delivery",
        { url: formUrl("confirm", tokenOf(req.query.token)), label: "Confirm notifications" },
      ));
    } catch (error) {
      next(error);
    }
  });

  router.post("/notification-recipient-confirmations/confirm", async (req, res, next) => {
    try {
      const subject = signedAction(req.query.token, "confirm");
      const confirmed = await dependencies.notificationRecipientPolicy.confirm(subject);
      res.setHeader("Cache-Control", "no-store");
      if (!confirmed) {
        res.status(410).type("html").send(confirmationPage("This confirmation link is no longer active"));
        return;
      }
      const revokeToken = signer.sign(subject.recipientId, "revoke", subject.generation);
      res.status(200).type("html").send(confirmationPage(
        "Notifications confirmed",
        { url: formUrl("revoke", revokeToken), label: "Stop sending me these notifications" },
      ));
    } catch (error) {
      next(error);
    }
  });

  router.get("/notification-recipient-confirmations/revoke", async (req, res, next) => {
    try {
      signedAction(req.query.token, "revoke");
      res.setHeader("Cache-Control", "no-store");
      res.status(200).type("html").send(confirmationPage(
        "Stop notification delivery",
        { url: formUrl("revoke", tokenOf(req.query.token)), label: "Stop sending me these notifications" },
      ));
    } catch (error) {
      next(error);
    }
  });

  router.post("/notification-recipient-confirmations/revoke", async (req, res, next) => {
    try {
      const revoked = await dependencies.notificationRecipientPolicy.revoke(signedAction(req.query.token, "revoke"));
      res.setHeader("Cache-Control", "no-store");
      res.sendStatus(revoked ? 200 : 410);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
