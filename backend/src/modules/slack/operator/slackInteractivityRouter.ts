import { Router, type Request } from "express";

import type { AppLogger } from "../../../shared/observability/logger.js";
import { isValidSlackSignature } from "../transport/slackSignature.js";
import type { SlackInteractivityHandlerPort, SlackInteractivityPayload } from "./slackInteractivityHandler.js";

interface InteractivityRequest extends Request {
  rawBody?: Buffer;
}

export interface SlackInteractivityRouterOptions {
  signingSecret: string;
  handler: SlackInteractivityHandlerPort;
  logger: Pick<AppLogger, "warn" | "info" | "error">;
  now?: () => number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parsePayload = (body: unknown): SlackInteractivityPayload | null => {
  if (!isObject(body) || typeof body.payload !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(body.payload) as unknown;
    if (!isObject(parsed) || typeof parsed.type !== "string") {
      return null;
    }
    if (!["block_actions", "view_submission", "view_closed"].includes(parsed.type)) {
      return null;
    }
    return parsed as SlackInteractivityPayload;
  } catch {
    return null;
  }
};

export const createSlackInteractivityRouter = (options: SlackInteractivityRouterOptions): Router => {
  const router = Router();

  router.post("/interactivity", async (req: InteractivityRequest, res, next) => {
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
        options.logger.warn({ event: "slack_interactivity", phase: "signature_rejected" }, "Slack interactivity signature verification failed");
        res.sendStatus(401);
        return;
      }

      const payload = parsePayload(req.body);
      if (!payload) {
        res.status(400).json({ error: "Malformed Slack interactivity payload" });
        return;
      }

      if (payload.type === "block_actions") {
        await options.handler.handleBlockActions(payload);
      } else if (payload.type === "view_submission") {
        await options.handler.handleViewSubmission(payload);
      } else {
        await options.handler.handleViewClosed(payload);
      }

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
