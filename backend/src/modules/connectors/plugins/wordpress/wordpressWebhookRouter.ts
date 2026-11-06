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
  ConnectorSourceDescriptor,
  ConnectorSourceReference,
  ConnectorStatePort,
} from "@radioso/connector-api";

import { externalIdFor, mapWebhookPostToIngestInput } from "./wordpressIngest.js";
import {
  connectedSiteForPush,
  wordpressPushHost,
  wordpressPushIsFromSite,
  wordpressSourceFor,
  type WordpressConnectedSitesPort,
  type WordpressPushOrigin,
} from "./wordpressSource.js";

// Metadata rules resolve a field by splitting its path on ".", so a dotted key
// could never match a rule. Keep the syntax identical to the workspace metadata
// key namespace so an operator can address a pushed field and an extracted one
// the same way.
const IndexedFieldKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
// Scalars only: a rule compares one value per key, so an array or object would
// silently never match.
const IndexedFieldValueSchema = z.union([z.string().max(256), z.number().finite(), z.boolean()]);
const MAX_INDEXED_FIELDS = 32;

const WordpressEventSchema = z.object({
  event: z.enum(["published", "updated", "deleted"]),
  site_url: z.string().url().optional(),
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
    date_gmt: z.string().optional(),
    // `id` is the WordPress user behind the byline. Catalogue post types keep the
    // real author in a taxonomy instead, so the companion plugin sends a name with
    // no account behind it; the ingest mapper only ever reads the name.
    author: z
      .object({ id: z.number().int().positive().optional(), name: z.string() })
      .optional(),
    // Facts the site publishes for retrieval to filter and boost on. The site
    // owns the vocabulary; this connector only enforces that a key is
    // addressable by a metadata rule and a value is comparable by one.
    fields: z
      .record(IndexedFieldKeySchema, IndexedFieldValueSchema)
      .refine((fields) => Object.keys(fields).length <= MAX_INDEXED_FIELDS, {
        message: `At most ${MAX_INDEXED_FIELDS} fields per post`,
      })
      .optional(),
  }),
});

interface WebhookDeps {
  logger: ConnectorLogger;
  state: Pick<ConnectorStatePort, "getConfig">;
  ingestion: Pick<ConnectorIngestionPort, "ingest" | "deleteByExternalId">;
  connectedSites: WordpressConnectedSitesPort;
}

interface PushTarget {
  /**
   * The configured site's descriptor, or a reference to an earlier site's
   * source: writing by reference means a source an operator deleted while the
   * push was in flight stays deleted.
   */
  source: ConnectorSourceDescriptor | ConnectorSourceReference;
  /** Set when the push writes to an earlier connected site rather than the configured one. */
  earlierSourceId: string | null;
}

interface CandidateSite {
  siteUrl: string;
  target: PushTarget;
}

/**
 * The source a signed push writes to: the configured site's, or the source of
 * a site the workspace connected before it. A site the workspace never
 * connected gets null: every site shares the workspace's secret, so a valid
 * signature alone must never let a site create a source.
 */
const resolvePushTarget = async (
  connectedSites: WordpressConnectedSitesPort,
  workspaceId: string,
  config: Record<string, string>,
  push: WordpressPushOrigin,
): Promise<PushTarget | null> => {
  const source = wordpressSourceFor(config);
  const configured: CandidateSite | null = source
    ? { siteUrl: source.config.siteUrl, target: { source, earlierSourceId: null } }
    : null;
  // A signed site URL names exactly one site, so a configured match needs no lookup.
  if (configured && push.siteUrl && wordpressPushIsFromSite(configured.siteUrl, push)) {
    return configured.target;
  }

  // A push with no site URL is matched by permalink, which can sit under nested
  // sites (an earlier install under a path of the configured one); the deepest wins.
  const earlier = (await connectedSites.listConnectedSites(workspaceId))
    .filter((site) => site.siteUrl !== configured?.siteUrl)
    .map((site): CandidateSite => ({
      siteUrl: site.siteUrl,
      target: { source: { id: site.sourceId }, earlierSourceId: site.sourceId },
    }));
  const candidates = configured ? [configured, ...earlier] : earlier;
  return connectedSiteForPush(candidates, push)?.target ?? null;
};

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

    const { event, post, site_url: payloadSiteUrl } = parsed.data;
    const externalDocumentId = externalIdFor(post.id);
    const push: WordpressPushOrigin = { siteUrl: payloadSiteUrl, link: post.link };

    try {
      const target = await resolvePushTarget(deps.connectedSites, workspaceId, config.config, push);
      if (!target) {
        deps.logger.warn(
          { workspaceId, externalDocumentId, event, siteHost: wordpressPushHost(push) },
          "wordpress webhook site does not match connector configuration",
        );
        res.status(403).json({ error: "Webhook site does not match connector configuration" });
        return;
      }
      if (target.earlierSourceId) {
        deps.logger.info(
          { workspaceId, externalDocumentId, event, sourceId: target.earlierSourceId },
          "wordpress webhook accepted for an earlier connected site",
        );
      }

      const { source } = target;
      if (event === "deleted") {
        const deleted = await deps.ingestion.deleteByExternalId({
          workspaceId,
          externalDocumentId,
          source,
        });
        deps.logger.info(
          { workspaceId, externalDocumentId, deleted },
          "wordpress webhook delete handled",
        );
      } else {
        await deps.ingestion.ingest({
          ...mapWebhookPostToIngestInput(workspaceId, post),
          source,
        });
        deps.logger.info(
          { workspaceId, externalDocumentId, event },
          "wordpress webhook ingest handled",
        );
      }
      res.status(204).end();
    } catch (error) {
      deps.logger.error(
        { workspaceId, externalDocumentId, event, err: error },
        "wordpress webhook ingest failed",
      );
      res.status(500).json({ error: "Ingest failed" });
    }
  });

  return router;
};
