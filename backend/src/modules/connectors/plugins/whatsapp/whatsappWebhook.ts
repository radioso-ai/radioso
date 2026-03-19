import { createHmac, timingSafeEqual } from "node:crypto";

import { Router, type Request } from "express";

import type { ConnectorLogger, ConnectorStatePort } from "../../domain/connectorPlugin.js";
import type { WhatsAppMessageHandler, WhatsAppInboundMessage } from "./whatsappMessageHandler.js";
import type { WhatsAppPersistencePort } from "./whatsappPersistence.js";

interface WhatsAppWebhookRouterOptions {
  logger: ConnectorLogger;
  state: Pick<ConnectorStatePort, "getConfig">;
  persistence: Pick<WhatsAppPersistencePort, "findMessageLogByWamid" | "createMessageLog">;
  messageHandler: Pick<WhatsAppMessageHandler, "handleInboundMessage">;
}

interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

const getWorkspaceId = (req: Request): string | null => {
  const workspaceId = req.params.workspaceId;
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : null;
};

interface WorkspaceParams {
  workspaceId: string;
}

export const createWhatsAppWebhookRouter = ({
  logger,
  state,
  persistence,
  messageHandler,
}: WhatsAppWebhookRouterOptions): Router => {
  const router = Router({ mergeParams: true });

  router.get("/:workspaceId/webhook", async (req: Request<WorkspaceParams>, res, next) => {
    try {
      const workspaceId = req.params.workspaceId;
      const config = await state.getConfig(workspaceId);
      if (!config) {
        res.sendStatus(404);
        return;
      }

      const mode = req.query["hub.mode"];
      const verifyToken = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (
        mode !== "subscribe" ||
        typeof verifyToken !== "string" ||
        verifyToken !== config.config.webhook_verify_token
      ) {
        res.sendStatus(403);
        return;
      }

      res.status(200).type("text/plain").send(typeof challenge === "string" ? challenge : "");
    } catch (error) {
      next(error);
    }
  });

  router.post("/:workspaceId/webhook", async (req: Request<WorkspaceParams> & WebhookRequest, res, next) => {
    try {
      const workspaceId = req.params.workspaceId;
      const config = await state.getConfig(workspaceId);
      if (!config) {
        res.sendStatus(404);
        return;
      }

      const signature = req.header("X-Hub-Signature-256");
      if (!signature || !isValidSignature(getRawBody(req), signature, config.config.app_secret)) {
        logger.warn({ workspaceId }, "WhatsApp webhook signature verification failed");
        res.sendStatus(401);
        return;
      }

      if (!config.enabled) {
        res.sendStatus(200);
        return;
      }

      const entries = extractInboundMessages(workspaceId, req.body as Record<string, unknown>);
      for (const message of entries) {
        const existing = await persistence.findMessageLogByWamid(message.wamid);
        if (existing) {
          logger.info({ workspaceId, waId: message.waId, wamid: message.wamid }, "WhatsApp duplicate webhook skipped");
          continue;
        }

        await persistence.createMessageLog({
          wamid: message.wamid,
          direction: "inbound",
          workspaceId: message.workspaceId,
          waId: message.waId,
          messageType: message.type,
          payload: message.payload,
          status: "received",
        });

        queueMicrotask(() => {
          void messageHandler.handleInboundMessage(message).catch((error) => {
            logger.error(
              {
                workspaceId: message.workspaceId,
                waId: message.waId,
                wamid: message.wamid,
                err: error instanceof Error ? error.message : String(error),
              },
              "WhatsApp inbound message processing failed",
            );
          });
        });
      }

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
};

const getRawBody = (request: WebhookRequest): Buffer =>
  request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));

const isValidSignature = (rawBody: Buffer, header: string, appSecret: string): boolean => {
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
};

const extractInboundMessages = (
  workspaceId: string,
  payload: Record<string, unknown>,
): WhatsAppInboundMessage[] => {
  if (payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) {
    return [];
  }

  const results: WhatsAppInboundMessage[] = [];

  for (const entry of payload.entry) {
    if (!entry || typeof entry !== "object" || !Array.isArray((entry as { changes?: unknown[] }).changes)) {
      continue;
    }

    for (const change of (entry as { changes: unknown[] }).changes) {
      if (!change || typeof change !== "object") {
        continue;
      }
      const value = (change as { value?: Record<string, unknown> }).value;
      if (!value || Array.isArray(value.statuses)) {
        continue;
      }

      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const contact = contacts[0] as { wa_id?: string; profile?: { name?: string } } | undefined;
      const waId = contact?.wa_id;
      const profileName = contact?.profile?.name ?? null;
      const messages = Array.isArray(value.messages) ? value.messages : [];

      for (const item of messages) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const message = item as Record<string, unknown>;
        if (message.type === "reaction") {
          continue;
        }

        const wamid = typeof message.id === "string" ? message.id : undefined;
        const from = typeof message.from === "string" ? message.from : waId;
        const timestamp = typeof message.timestamp === "string"
          ? new Date(Number(message.timestamp) * 1000)
          : new Date();
        const type = typeof message.type === "string" ? message.type : "unknown";
        const textBody =
          type === "text" &&
          message.text &&
          typeof message.text === "object" &&
          typeof (message.text as { body?: unknown }).body === "string"
            ? (message.text as { body: string }).body
            : undefined;

        if (!wamid || !from) {
          continue;
        }

        results.push({
          workspaceId,
          waId: from,
          profileName,
          wamid,
          timestamp,
          type,
          textBody,
          payload,
        });
      }
    }
  }

  return results;
};
