import { createHmac, timingSafeEqual } from "node:crypto";

import { Router, type Request } from "express";

import type { ConnectorLogger, ConnectorStatePort } from "@radioso/connector-api";

import type { WhatsAppInboundMessage, WhatsAppMessageHandler } from "./whatsappMessageHandler.js";
import type { WhatsAppPersistencePort } from "./whatsappPersistence.js";

interface WhatsAppWebhookRouterOptions {
  logger: ConnectorLogger;
  state: Pick<ConnectorStatePort, "getConfig">;
  persistence: Pick<WhatsAppPersistencePort, "createInboundMessageLog">;
  messageHandler: Pick<WhatsAppMessageHandler, "handleInboundMessage">;
}

interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

export const extractInboundMessages = (
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
      const metadataPhoneNumberId =
        value.metadata &&
        typeof value.metadata === "object" &&
        typeof (value.metadata as { phone_number_id?: unknown }).phone_number_id === "string"
          ? (value.metadata as { phone_number_id: string }).phone_number_id
          : null;

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
          phoneNumberId: metadataPhoneNumberId,
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

export const findInboundMessageInPayload = (
  workspaceId: string,
  payload: Record<string, unknown>,
  wamid: string,
): WhatsAppInboundMessage | null =>
  extractInboundMessages(workspaceId, payload).find((message) => message.wamid === wamid) ?? null;

export const createWhatsAppWebhookRouter = ({
  logger,
  state,
  persistence,
  messageHandler,
}: WhatsAppWebhookRouterOptions): Router => {
  const router = Router({ mergeParams: true });

  router.get("/", async (req, res, next) => {
    try {
      const workspaceId = (req.params as { workspaceId?: string }).workspaceId;
      if (!workspaceId) {
        res.status(400).json({ error: "Missing workspaceId" });
        return;
      }
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

  router.post("/", async (req: WebhookRequest, res, next) => {
    try {
      const workspaceId = (req.params as { workspaceId?: string }).workspaceId;
      if (!workspaceId) {
        res.status(400).json({ error: "Missing workspaceId" });
        return;
      }
      const config = await state.getConfig(workspaceId);
      if (!config) {
        res.sendStatus(404);
        return;
      }

      const rawBody = req.rawBody;
      if (!rawBody) {
        res.status(400).json({ error: "Raw body required" });
        return;
      }

      const signature = req.header("X-Hub-Signature-256");
      if (!signature || !isValidSignature(rawBody, signature, config.config.app_secret)) {
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
        if (message.phoneNumberId && message.phoneNumberId !== config.config.phone_number_id) {
          logger.warn(
            {
              workspaceId,
              wamid: message.wamid,
              receivedPhoneNumberId: message.phoneNumberId,
              configuredPhoneNumberId: config.config.phone_number_id,
            },
            "WhatsApp webhook phone number id mismatch",
          );
          continue;
        }

        const inserted = await persistence.createInboundMessageLog({
          wamid: message.wamid,
          workspaceId: message.workspaceId,
          waId: message.waId,
          messageType: message.type,
          payload: message.payload,
        });
        if (!inserted) {
          logger.info({ workspaceId, waId: message.waId, wamid: message.wamid }, "WhatsApp duplicate webhook skipped");
          continue;
        }

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

const isValidSignature = (rawBody: Buffer, header: string, appSecret: string): boolean => {
  if (!header.startsWith("sha256=")) {
    return false;
  }
  const provided = header.slice("sha256=".length);
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  if (provided.length !== expected.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
};
