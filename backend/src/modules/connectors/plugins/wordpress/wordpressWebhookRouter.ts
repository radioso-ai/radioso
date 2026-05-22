/**
 * WordPress webhook receiver.
 *
 * Mounted by the connector registry at:
 *   POST /api/connectors/wordpress/:workspaceId/webhook
 *
 * The companion PHP plugin POSTs signed JSON on save_post / before_delete_post.
 * Authenticity is verified via HMAC-SHA256 over the raw request body using the
 * workspace's configured webhook_shared_secret. Raw body is captured globally
 * in createApp.ts and exposed as `req.rawBody`.
 */

import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type {
  ConnectorIngestionPort,
  ConnectorLogger,
  ConnectorStatePort,
} from "@radioso/connector-api";

import {
  externalIdFor,
  mapWebhookPostToIngestInput,
  type WebhookPostPayload,
} from "./wordpressIngest.js";

const WordpressEventSchema = z.object({
  event: z.enum(["published", "updated", "deleted"]),
  post: z.object({
    id: z.number().int().positive(),
    type: z.string().min(1),
    status: z.string().min(1),
    slug: z.string(),
    title: z.string(),
    content_rendered: z.string().optional(),
    content_raw: z.string().optional(),
    excerpt_rendered: z.string().optional(),
    link: z.string().url(),
    modified_gmt: z.string(),
    author: z
      .object({ id: z.number().int().positive(), name: z.string() })
      .optional(),
  }),
});

interface WebhookDeps {
  logger: ConnectorLogger;
  state: ConnectorStatePort;
  ingestion: ConnectorIngestionPort;
}

const verifySignature = (body: Buffer, header: string, secret: string): boolean => {
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
};

export const createWordpressWebhookRouter = (deps: WebhookDeps): Router => {
  // mergeParams lets the inner router see :workspaceId mounted by the host.
  const router = Router({ mergeParams: true });

  router.post("/", async (req, res) => {
    const workspaceId = (req.params as { workspaceId?: string }).workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Missing workspaceId" });
      return;
    }

    const config = await deps.state.getConfig(workspaceId);
    if (!config || !config.enabled) {
      res.status(404).json({ error: "Connector not enabled for workspace" });
      return;
    }

    const secret = config.config["webhook_shared_secret"];
    if (!secret) {
      deps.logger.error({ workspaceId }, "wordpress webhook secret missing in stored config");
      res.status(500).json({ error: "Webhook secret not configured" });
      return;
    }

    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      // createApp.ts captures rawBody for all application/json requests.
      res.status(400).json({ error: "Raw body required" });
      return;
    }

    const signatureHeader = req.header("x-radioso-signature") ?? "";
    if (!verifySignature(rawBody, signatureHeader, secret)) {
      deps.logger.warn({ workspaceId }, "wordpress webhook signature mismatch");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const parsed = WordpressEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
      return;
    }

    const { event, post } = parsed.data;
    const externalDocumentId = externalIdFor(post.id);

    try {
      if (event === "deleted") {
        const deleted = await deps.ingestion.deleteByExternalId({
          workspaceId,
          externalDocumentId,
        });
        deps.logger.info(
          { workspaceId, externalDocumentId, deleted },
          "wordpress webhook delete handled",
        );
      } else {
        await deps.ingestion.ingest(
          mapWebhookPostToIngestInput(workspaceId, post as WebhookPostPayload),
        );
        deps.logger.info(
          { workspaceId, externalDocumentId, event },
          "wordpress webhook ingest handled",
        );
      }
      res.status(204).end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error(
        { workspaceId, externalDocumentId, event, err: message },
        "wordpress webhook ingest failed",
      );
      res.status(500).json({ error: "Ingest failed" });
    }
  });

  return router;
};
