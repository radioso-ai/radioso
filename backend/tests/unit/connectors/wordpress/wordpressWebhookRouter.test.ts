import express from "express";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import type { ConnectorIngestionPort, ConnectorStatePort } from "@radioso/connector-api";
import { createWordpressWebhookRouter } from "../../../../src/modules/connectors/plugins/wordpress/wordpressWebhookRouter.js";

const signBody = (body: string, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const setupApp = (overrides?: {
  state?: Partial<ConnectorStatePort>;
  ingestion?: Partial<ConnectorIngestionPort>;
}) => {
  const ingest = vi.fn(async () => ({ documentId: "doc-1", status: "queued" }));
  const deleteByExternalId = vi.fn(async () => true);
  const getConfig = vi.fn(async () => ({
    enabled: true,
    config: {
      site_url: "https://example.com",
      webhook_shared_secret: "topsecret",
    },
  }));

  const router = createWordpressWebhookRouter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    state: { getConfig, setErrorStatus: async () => {}, ...overrides?.state } as ConnectorStatePort,
    ingestion: { ingest, deleteByExternalId, ...overrides?.ingestion } as ConnectorIngestionPort,
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

  return { app, ingest, deleteByExternalId, getConfig };
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
