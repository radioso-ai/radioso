import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { NotificationRecipientTokenSigner } from "../../../modules/operatorNotifications/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import { readRequestSource } from "../middleware/requestSource.js";

type Dependencies = Pick<AppDependencies, "abuseControlService" | "auditService" | "env" | "notificationRecipientPolicy">;

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

  const confirmedSubject = (rawToken: unknown): { recipientId: string; generation: number } => {
    const subject = signer.verify(tokenOf(rawToken), "confirm");
    if (!subject || subject.generation === undefined) throw badRequest("Invalid notification recipient token");
    return { recipientId: subject.recipientId, generation: subject.generation };
  };
  const revokedSubject = (rawToken: unknown): { recipientId: string } => {
    const subject = signer.verify(tokenOf(rawToken), "revoke");
    if (!subject) throw badRequest("Invalid notification recipient token");
    return { recipientId: subject.recipientId };
  };

  const formUrl = (token: string, action?: "resume"): string => `${action ?? ""}?token=${encodeURIComponent(token)}`;
  const stopForm = (revokeToken: string) => ({ url: formUrl(revokeToken), label: "Stop sending me these notifications" });
  const publicRateLimit = createRateLimitMiddleware({
    service: dependencies.abuseControlService,
    auditService: dependencies.auditService,
    scope: "notification_recipient_confirmation.public",
    limit: 120,
    windowMs: 60 * 60 * 1000,
    blockMs: 60 * 1000,
    resolveSubjectKey: (req, res) => readRequestSource(req, res).digest,
  });

  router.get("/notification-recipient-confirmations/confirm", publicRateLimit, async (req, res, next) => {
    try {
      confirmedSubject(req.query.token);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).type("html").send(confirmationPage(
        "Confirm notification delivery",
        { url: formUrl(tokenOf(req.query.token)), label: "Confirm notifications" },
      ));
    } catch (error) {
      next(error);
    }
  });

  router.post("/notification-recipient-confirmations/confirm", publicRateLimit, async (req, res, next) => {
    try {
      const subject = confirmedSubject(req.query.token);
      const confirmed = await dependencies.notificationRecipientPolicy.confirm(subject);
      res.setHeader("Cache-Control", "no-store");
      if (!confirmed) {
        res.status(410).type("html").send(confirmationPage("This confirmation link is no longer active"));
        return;
      }
      res.status(200).type("html").send(confirmationPage(
        "Notifications confirmed",
        stopForm(signer.sign(subject.recipientId, "revoke")),
      ));
    } catch (error) {
      next(error);
    }
  });

  router.get("/notification-recipient-confirmations/revoke", publicRateLimit, async (req, res, next) => {
    try {
      revokedSubject(req.query.token);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).type("html").send(confirmationPage("Stop notification delivery", stopForm(tokenOf(req.query.token))));
    } catch (error) {
      next(error);
    }
  });

  // Also the RFC 8058 one-click target, so a repeat stop succeeds rather than reporting a gone link.
  router.post("/notification-recipient-confirmations/revoke", publicRateLimit, async (req, res, next) => {
    try {
      const token = tokenOf(req.query.token);
      await dependencies.notificationRecipientPolicy.revoke(revokedSubject(token));
      res.setHeader("Cache-Control", "no-store");
      res.status(200).type("html").send(confirmationPage(
        "You will not receive these notifications",
        { url: formUrl(token, "resume"), label: "Resume notifications" },
      ));
    } catch (error) {
      next(error);
    }
  });

  router.post("/notification-recipient-confirmations/resume", publicRateLimit, async (req, res, next) => {
    try {
      const token = tokenOf(req.query.token);
      const resumed = await dependencies.notificationRecipientPolicy.resume(revokedSubject(token));
      res.setHeader("Cache-Control", "no-store");
      if (!resumed) {
        res.status(410).type("html").send(confirmationPage("This link is no longer active"));
        return;
      }
      res.status(200).type("html").send(confirmationPage("Notifications resumed", stopForm(token)));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
