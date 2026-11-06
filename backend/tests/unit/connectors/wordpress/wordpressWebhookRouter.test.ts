import express from "express";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import type { ConnectorIngestionPort, ConnectorStatePort } from "@radioso/connector-api";
import type {
  WordpressConnectedSite,
  WordpressConnectedSitesPort,
} from "../../../../src/modules/connectors/plugins/wordpress/wordpressSource.js";
import { createWordpressWebhookRouter } from "../../../../src/modules/connectors/plugins/wordpress/wordpressWebhookRouter.js";

const signBody = (body: string, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

// A site the workspace connected before its current one: its source and
// documents are still in the workspace, and its plugin still pushes.
const earlierSite: WordpressConnectedSite = {
  sourceId: "src-earlier",
  siteUrl: "https://earlier.example.org",
};
// A second install under a path of the configured site (https://example.com).
const nestedEarlierSite: WordpressConnectedSite = {
  sourceId: "src-blog",
  siteUrl: "https://example.com/blog",
};

const setupApp = (overrides?: {
  state?: Partial<ConnectorStatePort>;
  ingestion?: Partial<ConnectorIngestionPort>;
  connectedSites?: WordpressConnectedSite[] | Error;
}) => {
  const ingest = vi.fn(async () => ({ documentId: "doc-1", status: "queued" }));
  const deleteByExternalId = vi.fn(async () => true);
  const listConnectedSites = vi.fn<WordpressConnectedSitesPort["listConnectedSites"]>(
    async () => {
      if (overrides?.connectedSites instanceof Error) throw overrides.connectedSites;
      return overrides?.connectedSites ?? [];
    },
  );
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const getConfig = vi.fn(async () => ({
    enabled: true,
    config: {
      site_url: "https://example.com",
      webhook_shared_secret: "topsecret",
    },
  }));

  const router = createWordpressWebhookRouter({
    logger,
    state: { getConfig, setErrorStatus: async () => {}, ...overrides?.state },
    ingestion: { ingest, deleteByExternalId, ...overrides?.ingestion },
    connectedSites: { listConnectedSites },
  });

  const app = express();
  // Mimic the production rawBody capture from createApp.ts.
  app.use(async (req, _res, next) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);
    (req as typeof req & { rawBody?: Buffer }).rawBody = rawBody;
    try {
      req.body = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
    } catch {
      req.body = {};
    }
    next();
  });
  app.use("/api/connectors/wordpress/:workspaceId/webhook", router);

  return { app, ingest, deleteByExternalId, getConfig, listConnectedSites, logger };
};

const postSigned = (app: express.Express, payload: unknown, secret = "topsecret") => {
  const body = JSON.stringify(payload);
  return request(app)
    .post("/api/connectors/wordpress/ws-1/webhook")
    .set("content-type", "application/json")
    .set("x-radioso-signature", signBody(body, secret))
    .send(body);
};

describe("wordpressWebhookRouter", () => {
  const validPost = {
    id: 1,
    type: "page",
    status: "publish",
    slug: "home",
    title: "Home",
    content_raw: "<p>hi</p>",
    link: "https://example.com/home",
    modified_gmt: "2026-05-16T00:00:00",
  };

  it("rejects requests with no signature", async () => {
    const { app } = setupApp();
    const body = JSON.stringify({ event: "published", post: validPost });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("rejects requests with an invalid signature", async () => {
    const { app } = setupApp();
    const body = JSON.stringify({ event: "published", post: validPost });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", "sha256=deadbeef")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("ingests on a valid signed publish event", async () => {
    const { app, ingest } = setupApp();
    const body = JSON.stringify({ event: "published", post: validPost });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(204);
    expect(ingest).toHaveBeenCalledTimes(1);
    const firstCallArgs = ingest.mock.calls[0] as unknown as [
      { workspaceId: string; externalDocumentId: string; title: string },
    ];
    expect(firstCallArgs[0]).toMatchObject({
      workspaceId: "ws-1",
      externalDocumentId: "wp_post_1",
      title: "Home",
      source: {
        externalId: "wordpress:https://example.com",
      },
    });
  });

  it("settles a push signed with the configured site URL without looking up other sites", async () => {
    const { app, ingest, listConnectedSites } = setupApp({ connectedSites: [nestedEarlierSite] });

    const res = await postSigned(app, {
      event: "updated",
      site_url: "https://example.com/",
      post: { ...validPost, link: "https://example.com/blog-archive" },
    });

    expect(res.status).toBe(204);
    expect(ingest.mock.calls[0]).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ externalId: "wordpress:https://example.com" }) }),
    ]);
    expect(listConnectedSites).not.toHaveBeenCalled();
  });

  it("accepts a taxonomy-sourced author that carries no WordPress user id", async () => {
    // Catalogue post types (e.g. WooCommerce products) keep the real author in a
    // taxonomy, so the companion plugin sends a name with no `post_author` behind it.
    const { app, ingest } = setupApp();
    const body = JSON.stringify({
      event: "published",
      post: { ...validPost, author: { name: "Swami Kriyananda" } },
    });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(204);
    const firstCallArgs = ingest.mock.calls[0] as unknown as [
      { metadata: Record<string, unknown> },
    ];
    expect(firstCallArgs[0].metadata).toMatchObject({ author: "Swami Kriyananda" });
  });

  it("forwards scalar fields as indexed fields", async () => {
    const { app, ingest } = setupApp();
    const body = JSON.stringify({
      event: "published",
      post: {
        ...validPost,
        fields: { price: 17, sale_price: 12.5, on_sale: true, sku: "AEY0112" },
      },
    });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(204);
    const firstCallArgs = ingest.mock.calls[0] as unknown as [
      { indexedFields?: Record<string, unknown> },
    ];
    expect(firstCallArgs[0].indexedFields).toEqual({
      price: 17,
      sale_price: 12.5,
      on_sale: true,
      sku: "AEY0112",
    });
  });

  it("rejects a field key that a metadata rule could not address", async () => {
    // Rule fields are resolved by splitting the path on ".", so a dotted key
    // would silently never match. Reject it at the edge instead.
    const { app, ingest } = setupApp();
    const body = JSON.stringify({
      event: "published",
      post: { ...validPost, fields: { "product.price": 17 } },
    });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects a non-scalar field value", async () => {
    const { app, ingest } = setupApp();
    const body = JSON.stringify({
      event: "published",
      post: { ...validPost, fields: { formats: ["paperback", "ebook"] } },
    });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects a validly signed event from a different WordPress site", async () => {
    const { app, ingest } = setupApp();
    const body = JSON.stringify({
      event: "published",
      site_url: "https://site-one.example",
      post: {
        ...validPost,
        link: "https://site-one.example/home",
      },
    });

    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Webhook site does not match connector configuration" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects a post permalink outside the signed WordPress site", async () => {
    const { app, ingest } = setupApp();
    const body = JSON.stringify({
      event: "published",
      site_url: "https://example.com",
      post: {
        ...validPost,
        link: "https://other.example/home",
      },
    });

    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("calls deleteByExternalId on a valid signed delete event", async () => {
    const { app, deleteByExternalId } = setupApp();
    const body = JSON.stringify({ event: "deleted", post: validPost });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(204);
    expect(deleteByExternalId).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      externalDocumentId: "wp_post_1",
      source: {
        externalId: "wordpress:https://example.com",
        name: "example.com",
        config: { siteUrl: "https://example.com" },
        metadata: { connectorId: "wordpress" },
      },
    });
  });

  describe("sites the workspace connected before its current one", () => {
    const earlierPost = { ...validPost, id: 7, link: "https://earlier.example.org/about" };

    it("ingests a push from an earlier site into that site's own source", async () => {
      const { app, ingest, listConnectedSites, logger } = setupApp({ connectedSites: [earlierSite] });

      const res = await postSigned(app, {
        event: "updated",
        site_url: "https://earlier.example.org/",
        post: earlierPost,
      });

      expect(res.status).toBe(204);
      expect(listConnectedSites).toHaveBeenCalledWith("ws-1");
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(ingest.mock.calls[0]).toEqual([
        expect.objectContaining({
          workspaceId: "ws-1",
          externalDocumentId: "wp_post_7",
          source: { id: "src-earlier" },
        }),
      ]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", sourceId: "src-earlier" }),
        "wordpress webhook accepted for an earlier connected site",
      );
    });

    it("deletes from the earlier site's own source", async () => {
      const { app, deleteByExternalId } = setupApp({ connectedSites: [earlierSite] });

      const res = await postSigned(app, {
        event: "deleted",
        site_url: "https://earlier.example.org/",
        post: { ...earlierPost, status: "trash", link: "https://earlier.example.org/?p=7" },
      });

      expect(res.status).toBe(204);
      expect(deleteByExternalId).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        externalDocumentId: "wp_post_7",
        source: { id: "src-earlier" },
      });
    });

    it("matches a push that names no site URL by its permalink", async () => {
      const { app, ingest } = setupApp({ connectedSites: [earlierSite] });

      const res = await postSigned(app, { event: "published", post: earlierPost });

      expect(res.status).toBe(204);
      expect(ingest.mock.calls[0]).toEqual([
        expect.objectContaining({ source: { id: "src-earlier" } }),
      ]);
    });

    it("routes an unsigned push from an install nested under the configured site to that install", async () => {
      const { app, ingest, deleteByExternalId } = setupApp({ connectedSites: [nestedEarlierSite] });

      const published = await postSigned(app, {
        event: "updated",
        post: { ...validPost, id: 42, link: "https://example.com/blog/welcome" },
      });
      const deleted = await postSigned(app, {
        event: "deleted",
        post: { ...validPost, id: 42, link: "https://example.com/blog/welcome" },
      });

      expect(published.status).toBe(204);
      expect(deleted.status).toBe(204);
      expect(ingest.mock.calls[0]).toEqual([
        expect.objectContaining({ externalDocumentId: "wp_post_42", source: { id: "src-blog" } }),
      ]);
      expect(deleteByExternalId).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        externalDocumentId: "wp_post_42",
        source: { id: "src-blog" },
      });
    });

    it("keeps an unsigned push outside the nested install on the configured site", async () => {
      const { app, ingest } = setupApp({ connectedSites: [nestedEarlierSite] });

      const res = await postSigned(app, { event: "updated", post: validPost });

      expect(res.status).toBe(204);
      expect(ingest.mock.calls[0]).toEqual([
        expect.objectContaining({ source: expect.objectContaining({ externalId: "wordpress:https://example.com" }) }),
      ]);
    });

    it("rejects an earlier site's push whose permalink sits outside that site", async () => {
      const { app, ingest } = setupApp({ connectedSites: [earlierSite] });

      const res = await postSigned(app, {
        event: "updated",
        site_url: "https://earlier.example.org/",
        post: { ...earlierPost, link: "https://elsewhere.example.net/about" },
      });

      expect(res.status).toBe(403);
      expect(ingest).not.toHaveBeenCalled();
    });

    it("rejects a site the workspace never connected and logs only its host", async () => {
      const { app, ingest, deleteByExternalId, logger } = setupApp({ connectedSites: [earlierSite] });

      const res = await postSigned(app, {
        event: "published",
        site_url: "https://unknown.example.net/",
        post: { ...validPost, title: "Private title", link: "https://unknown.example.net/home" },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Webhook site does not match connector configuration" });
      expect(ingest).not.toHaveBeenCalled();
      expect(deleteByExternalId).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { workspaceId: "ws-1", externalDocumentId: "wp_post_1", event: "published", siteHost: "unknown.example.net" },
        "wordpress webhook site does not match connector configuration",
      );
    });

    it("returns 500 when the connected-site lookup fails", async () => {
      const { app, ingest } = setupApp({ connectedSites: new Error("db down") });

      const res = await postSigned(app, {
        event: "updated",
        site_url: "https://earlier.example.org/",
        post: earlierPost,
      });

      expect(res.status).toBe(500);
      expect(ingest).not.toHaveBeenCalled();
    });

    it("checks the signature before looking up any connected site", async () => {
      const { app, ingest, listConnectedSites } = setupApp({ connectedSites: [earlierSite] });

      const res = await postSigned(
        app,
        { event: "updated", site_url: "https://earlier.example.org/", post: earlierPost },
        "not-the-workspace-secret",
      );

      expect(res.status).toBe(401);
      expect(listConnectedSites).not.toHaveBeenCalled();
      expect(ingest).not.toHaveBeenCalled();
    });
  });

  it("returns 404 when the connector is not enabled for the workspace", async () => {
    const { app, ingest } = setupApp({
      state: { getConfig: async () => null },
    });
    const body = JSON.stringify({ event: "published", post: validPost });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(404);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("returns 400 when the payload shape is invalid", async () => {
    const { app, ingest } = setupApp();
    const body = JSON.stringify({ event: "published", post: { id: -1 } });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("returns 500 when ingestion throws", async () => {
    const { app } = setupApp({
      ingestion: {
        ingest: async () => {
          throw new Error("db down");
        },
      },
    });
    const body = JSON.stringify({ event: "published", post: validPost });
    const res = await request(app)
      .post("/api/connectors/wordpress/ws-1/webhook")
      .set("content-type", "application/json")
      .set("x-radioso-signature", signBody(body, "topsecret"))
      .send(body);

    expect(res.status).toBe(500);
  });
});
