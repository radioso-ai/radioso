import { createHmac, timingSafeEqual } from "node:crypto";

import { Router, type Request } from "express";

import type { ConnectorLogger } from "@radioso/connector-api";

import type { SlackInstallationRepositoryPort } from "../../../slack/public.js";
import type { SlackMessageHandler, SlackMessageImEvent } from "./slackMessageHandler.js";
import type { SlackPersistencePort } from "./slackPersistence.js";

interface SlackWebhookRouterOptions {
  logger: ConnectorLogger;
  signingSecret: string;
  installations: SlackInstallationRepositoryPort;
  persistence: Pick<SlackPersistencePort, "createInboundEvent" | "markInboundEventStatus">;
  messageHandler: Pick<SlackMessageHandler, "handleMessageIm" | "isBotLoop">;
  now?: () => number;
}

interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

const REPLAY_WINDOW_SECONDS = 5 * 60;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const parseMessageImEvent = (event: unknown): SlackMessageImEvent | null => {
  if (!isObject(event)) {
    return null;
  }
  if (event.type !== "message" || event.channel_type !== "im") {
    return null;
  }
  const channel = readString(event.channel);
  const user = readString(event.user);
  const text = typeof event.text === "string" ? event.text : null;
  if (!channel || !user || text === null) {
    return null;
  }
  return {
    type: "message",
    channel_type: "im",
    channel,
    user,
    text,
    ...(readString(event.ts) ? { ts: readString(event.ts)! } : {}),
    ...(readString(event.bot_id) ? { bot_id: readString(event.bot_id)! } : {}),
  };
};

export const isValidSlackSignature = (input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  signingSecret: string;
  nowMs?: number;
}): boolean => {
  const signature = input.signatureHeader;
  const timestamp = input.timestampHeader;
  if (!signature?.startsWith("v0=") || !timestamp) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > REPLAY_WINDOW_SECONDS) {
    return false;
  }
  const base = `v0:${timestamp}:${input.rawBody.toString("utf8")}`;
  const expected = `v0=${createHmac("sha256", input.signingSecret).update(base).digest("hex")}`;
  if (signature.length !== expected.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
};

export const createSlackWebhookRouter = (options: SlackWebhookRouterOptions): Router => {
  const router = Router();

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

      const payload = isObject(req.body) ? req.body : {};
      if (payload.type === "url_verification") {
        res.status(200).json({ challenge: readString(payload.challenge) ?? "" });
        return;
      }

      const eventId = readString(payload.event_id);
      const teamId = readString(payload.team_id);
      if (payload.type !== "event_callback" || !eventId || !teamId) {
        res.sendStatus(200);
        return;
      }

      const inserted = await options.persistence.createInboundEvent({ eventId, teamId });
      if (!inserted) {
        options.logger.info({ teamId, eventId }, "Slack duplicate inbound event skipped");
        res.sendStatus(200);
        return;
      }

      const event = parseMessageImEvent(payload.event);
      if (!event) {
        await options.persistence.markInboundEventStatus(eventId, "skipped");
        res.sendStatus(200);
        return;
      }

      const installation = await options.installations.findByTeamId(teamId);
      if (options.messageHandler.isBotLoop(installation, event)) {
        await options.persistence.markInboundEventStatus(eventId, "skipped");
        res.sendStatus(200);
        return;
      }

      queueMicrotask(() => {
        void options.messageHandler.handleMessageIm({ eventId, teamId, event }).catch((error) => {
          options.logger.error(
            { teamId, eventId, err: error instanceof Error ? error.message : String(error) },
            "Slack inbound event processing failed",
          );
        });
      });

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
