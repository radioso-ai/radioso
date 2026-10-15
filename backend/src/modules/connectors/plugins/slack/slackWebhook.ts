import { Router, type Request } from "express";

import type { ConnectorLogger } from "@radioso/connector-api";

import { isValidSlackSignature, type SlackInstallationRepositoryPort } from "../../../slack/public.js";
import { isSlackBotLoop } from "./slackMessageHandler.js";
import {
  isSlackPayloadObject,
  parseSlackInboundEvent,
  readSlackPayloadString,
  slackInboundEventJobRequest,
} from "./slackInboundEventJob.js";
import type { SlackPersistencePort } from "./slackPersistence.js";

interface SlackWebhookRouterOptions {
  logger: ConnectorLogger;
  signingSecret: string;
  installations: Pick<SlackInstallationRepositoryPort, "findByTeamId">;
  persistence: Pick<SlackPersistencePort, "createInboundEvent" | "markInboundEventStatus" | "enqueueInboundEvent">;
  now?: () => number;
}

interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

export const createSlackWebhookRouter = (options: SlackWebhookRouterOptions): Router => {
  const router = Router();

  // Dedupes-and-marks-skipped for an event the worker will never see a job for. Shares the
  // dedupe row with `enqueueInboundEvent`'s own insert so a redelivery of an already-skipped
  // event is still recognised as a duplicate.
  const skip = async (eventId: string, teamId: string): Promise<void> => {
    const inserted = await options.persistence.createInboundEvent({ eventId, teamId });
    if (inserted) {
      await options.persistence.markInboundEventStatus(eventId, "skipped");
    }
  };

  router.post("/events", async (req: WebhookRequest, res, next) => {
    try {
      const rawBody = req.rawBody;
      if (!rawBody) {
        res.status(400).json({ error: "Raw body required" });
        return;
      }
      if (!isValidSlackSignature({
        rawBody,
        signatureHeader: req.header("X-Slack-Signature"),
        timestampHeader: req.header("X-Slack-Request-Timestamp"),
        signingSecret: options.signingSecret,
        nowMs: options.now?.(),
      })) {
        options.logger.warn({ event: "slack_inbound", phase: "signature_rejected" }, "Slack signature verification failed");
        res.sendStatus(401);
        return;
      }

      const payload = isSlackPayloadObject(req.body) ? req.body : {};
      if (payload.type === "url_verification") {
        res.status(200).json({ challenge: readSlackPayloadString(payload.challenge) ?? "" });
        return;
      }

      const eventId = readSlackPayloadString(payload.event_id);
      const teamId = readSlackPayloadString(payload.team_id);
      if (payload.type !== "event_callback" || !eventId || !teamId) {
        res.sendStatus(200);
        return;
      }

      const inbound = parseSlackInboundEvent(payload.event);
      if (!inbound) {
        await skip(eventId, teamId);
        res.sendStatus(200);
        return;
      }

      const installation = await options.installations.findByTeamId(teamId);
      if (isSlackBotLoop(installation, inbound.event)) {
        await skip(eventId, teamId);
        res.sendStatus(200);
        return;
      }

      // Verification, dedupe-insert, and job-insert all commit (or roll back) together inside
      // `enqueueInboundEvent`; the worker's job handler runs the existing dispatch and marks the
      // inbound event `processed`/`skipped`/`failed` once the port has run its course.
      const outcome = await options.persistence.enqueueInboundEvent({
        eventId,
        teamId,
        job: slackInboundEventJobRequest({ eventId, teamId, inbound }),
      });
      if (outcome === "duplicate") {
        options.logger.info({ teamId, eventId }, "Slack duplicate inbound event skipped");
      }

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
