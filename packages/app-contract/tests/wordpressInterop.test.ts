import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  hostCapabilityCallSchema,
  invocationRequestSchema,
  releaseAValidationPolicy,
  validateManifest,
  webhookInvocationInputSchema,
  type AppManifest,
} from "../src/index.js";

/**
 * The manifest says what the WordPress App may declare. This says the App can
 * still carry what the companion plugin already sends: the same signed bytes,
 * the same `wp_post_<id>` identity, the same rendered HTML, the same author and
 * date metadata, and the same site-owned field map — including a key like
 * `ISBN` that a catalogue registers in its own case.
 */
const fixturePath = fileURLToPath(new URL("../fixtures/reference/wordpress.manifest.json", import.meta.url));
const fixtureResult = validateManifest(
  JSON.parse(readFileSync(fixturePath, "utf8")) as unknown,
  releaseAValidationPolicy,
);
if (!fixtureResult.ok) throw new Error("the reference WordPress manifest must validate");
const manifest: AppManifest = fixtureResult.manifest;

const SIGNING_SECRET = "b2f0d1c4e5a6978877665544332211009988aabbccddeeff0011223344556677";
const SOURCE_CONTRIBUTION_ID = "site_content";

/** What `radioso_dispatch()` builds, for a post and for a WooCommerce product. */
interface PluginPost {
  id: number;
  type: string;
  status: string;
  slug: string;
  title: string;
  content_raw: string;
  content_rendered: string;
  excerpt_rendered: string;
  link: string;
  modified_gmt: string;
  date_gmt: string;
  author?: { id?: number; name: string };
  fields?: Record<string, string | number | boolean>;
}

interface PluginPayload {
  event: "published" | "updated" | "deleted";
  site_url: string;
  post: PluginPost;
}

const publishedPayload: PluginPayload = {
  event: "published",
  site_url: "https://example.com/",
  post: {
    id: 4211,
    type: "post",
    status: "publish",
    slug: "how-we-price-books",
    title: "How we price books",
    content_raw: "<!-- wp:paragraph --><p>Every edition is priced once.</p><!-- /wp:paragraph -->",
    content_rendered: "<p>Every edition is priced once.</p>",
    excerpt_rendered: "<p>Every edition is priced once.</p>",
    link: "https://example.com/how-we-price-books/",
    modified_gmt: "2026-09-02T09:15:00",
    date_gmt: "2026-09-01T08:00:00",
    author: { id: 7, name: "Ada Lovelace" },
  },
};

const updatedProductPayload: PluginPayload = {
  event: "updated",
  site_url: "https://example.com/",
  post: {
    id: 5120,
    type: "product",
    status: "publish",
    slug: "la-divina-commedia",
    title: "La Divina Commedia",
    content_raw: "<p>Hardback edition.</p>",
    content_rendered: "<p>Hardback edition.</p><h3>Product facts</h3><ul><li>SKU: AE-1029</li></ul>",
    excerpt_rendered: "<p>Hardback edition.</p>",
    link: "https://example.com/product/la-divina-commedia/",
    modified_gmt: "2026-09-05T11:42:10",
    date_gmt: "2026-04-18T07:30:00",
    author: { name: "Dante Alighieri" },
    fields: {
      sku: "AE-1029",
      price: 24.5,
      regular_price: 29,
      currency: "EUR",
      on_sale: true,
      stock_status: "instock",
      // A catalogue registers this attribute itself, in its own case.
      ISBN: "9788894000000",
    },
  },
};

const deletedPayload: PluginPayload = {
  event: "deleted",
  site_url: "https://example.com/",
  post: {
    ...publishedPayload.post,
    status: "trash",
  },
};

/** The plugin signs the exact bytes it sends, so the test does too. */
const signRawBody = (rawBody: Buffer): string =>
  `sha256=${createHmac("sha256", SIGNING_SECRET).update(rawBody).digest("hex")}`;

const deliver = (payload: PluginPayload) => {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    rawBody,
    input: {
      kind: "webhook" as const,
      deliveryId: `wp-${payload.post.id}-${payload.event}`,
      receivedAt: "2026-09-06T12:00:00.000Z",
      headers: {
        "Content-Type": "application/json",
        "X-Radioso-Signature": signRawBody(rawBody),
        "X-Radioso-Event": payload.event,
      },
      body: { encoding: "base64" as const, data: rawBody.toString("base64") },
    },
  };
};

const webhookContribution = manifest.contributions[1];
if (webhookContribution.kind !== "external_webhook_handler") {
  throw new Error("content_push must be a webhook handler");
}
const { signatureHeader, signaturePrefix } = webhookContribution.authentication;

const verifiedBodyOf = (payload: PluginPayload): PluginPayload => {
  const parsed = webhookInvocationInputSchema.parse(deliver(payload).input);
  const decoded = Buffer.from(parsed.body.data, "base64");
  const presented = parsed.headers[signatureHeader];
  expect(presented?.startsWith(signaturePrefix ?? "")).toBe(true);
  const expected = Buffer.from(signRawBody(decoded), "utf8");
  const provided = Buffer.from(presented ?? "", "utf8");
  expect(provided.length).toBe(expected.length);
  expect(timingSafeEqual(provided, expected)).toBe(true);
  return JSON.parse(decoded.toString("utf8")) as PluginPayload;
};

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/u;
const asInstant = (wordpressGmt: string): string => `${wordpressGmt}Z`;

/** What the App would ask the host to write, given one verified push. */
const ingestCallFor = (payload: PluginPayload): unknown => {
  const post = payload.post;
  const isoDay = ISO_DAY.exec(post.date_gmt)?.[1];
  return {
    protocolVersion: 1,
    invocationId: "8b1f6f2a-6f6f-4a3f-9c4a-2f0d0f8a1b21",
    capabilitySession: "opaque-session-token",
    requestId: `wp_post_${post.id}:${post.modified_gmt}`,
    request: {
      capability: "documents.ingest",
      sourceContributionId: SOURCE_CONTRIBUTION_ID,
      document: {
        externalDocumentId: `wp_post_${post.id}`,
        title: post.title,
        content: { format: "html", value: post.content_rendered },
        sourceUrl: post.link,
        ...(post.fields ? { indexedFields: post.fields } : {}),
        metadata: {
          source: "wordpress",
          wp_post_id: post.id,
          wp_post_type: post.type,
          wp_status: post.status,
          wp_slug: post.slug,
          ...(isoDay ? { dateFrom: isoDay } : {}),
        },
        publishedAt: asInstant(post.date_gmt),
        modifiedAt: asInstant(post.modified_gmt),
        ...(post.author ? { author: post.author.name } : {}),
      },
    },
  };
};

describe("companion plugin interoperability", () => {
  it("verifies a published push over the exact bytes, after a base64 round trip", () => {
    expect(verifiedBodyOf(publishedPayload)).toEqual(publishedPayload);
  });

  it("refuses a body whose bytes changed after signing", () => {
    const delivery = deliver(publishedPayload);
    const tampered = Buffer.from(
      JSON.stringify({ ...publishedPayload, post: { ...publishedPayload.post, title: "Rewritten" } }),
      "utf8",
    );
    const parsed = webhookInvocationInputSchema.parse({
      ...delivery.input,
      body: { encoding: "base64", data: tampered.toString("base64") },
    });
    const decoded = Buffer.from(parsed.body.data, "base64");
    expect(signRawBody(decoded)).not.toBe(parsed.headers[signatureHeader]);
  });

  it("maps a published push onto a documents.ingest call the contract accepts", () => {
    const call = hostCapabilityCallSchema.parse(ingestCallFor(verifiedBodyOf(publishedPayload)));
    if (call.request.capability !== "documents.ingest") throw new Error("expected an ingest call");
    expect(call.request.sourceContributionId).toBe(SOURCE_CONTRIBUTION_ID);
    expect(call.request.document.externalDocumentId).toBe("wp_post_4211");
    expect(call.request.document.content.format).toBe("html");
    expect(call.request.document.author).toBe("Ada Lovelace");
    expect(call.request.document.publishedAt).toBe("2026-09-01T08:00:00Z");
    expect(call.request.document.modifiedAt).toBe("2026-09-02T09:15:00Z");
    expect(call.request.document.metadata).toMatchObject({
      wp_post_type: "post",
      wp_status: "publish",
      dateFrom: "2026-09-01",
    });
  });

  it("keeps a WooCommerce field map, including a key the catalogue capitalises", () => {
    const call = hostCapabilityCallSchema.parse(ingestCallFor(verifiedBodyOf(updatedProductPayload)));
    if (call.request.capability !== "documents.ingest") throw new Error("expected an ingest call");
    expect(call.request.document.indexedFields).toEqual({
      sku: "AE-1029",
      price: 24.5,
      regular_price: 29,
      currency: "EUR",
      on_sale: true,
      stock_status: "instock",
      ISBN: "9788894000000",
    });
    const source = manifest.contributions[0];
    if (source.kind !== "document_source") throw new Error("site_content must be a document source");
    if (source.indexedFields.policy !== "dynamic") throw new Error("site_content owns a dynamic vocabulary");
    expect(Object.keys(call.request.document.indexedFields ?? {}).length).toBeLessThanOrEqual(
      source.indexedFields.maxFields,
    );
  });

  it("repeats one requestId across retries of the same logical effect", () => {
    const first = hostCapabilityCallSchema.parse(ingestCallFor(verifiedBodyOf(updatedProductPayload)));
    const second = hostCapabilityCallSchema.parse(ingestCallFor(verifiedBodyOf(updatedProductPayload)));
    expect(second.requestId).toBe(first.requestId);
  });

  it("maps a deleted push onto a documents.delete call in the same namespace", () => {
    const payload = verifiedBodyOf(deletedPayload);
    const call = hostCapabilityCallSchema.parse({
      protocolVersion: 1,
      invocationId: "8b1f6f2a-6f6f-4a3f-9c4a-2f0d0f8a1b21",
      capabilitySession: "opaque-session-token",
      requestId: `wp_post_${payload.post.id}:deleted`,
      request: {
        capability: "documents.delete",
        sourceContributionId: SOURCE_CONTRIBUTION_ID,
        externalDocumentId: `wp_post_${payload.post.id}`,
      },
    });
    if (call.request.capability !== "documents.delete") throw new Error("expected a delete call");
    expect(call.request.externalDocumentId).toBe("wp_post_4211");
  });
});

/** The interval a configuration value resolves to, or nothing at all. */
const resolvedIntervalSeconds = (configuredValue: number): number | null => {
  const poll = manifest.contributions[2];
  if (poll.kind !== "scheduled_task") throw new Error("content_poll must be a scheduled task");
  if (poll.schedule.kind !== "interval_from_configuration") throw new Error("content_poll reads its interval");
  if (poll.schedule.disabledValue === configuredValue) return null;
  return Math.max(configuredValue, poll.schedule.minSeconds);
};

describe("installation shapes the WordPress App has to cover", () => {
  it("leaves a push-only installation with no schedule at all", () => {
    const postTypes = manifest.configuration.fields.find((field) => field.key === "post_types");
    const interval = manifest.configuration.fields.find((field) => field.key === "poll_interval_sec");
    if (postTypes?.type !== "text" || interval?.type !== "number") {
      throw new Error("the default installation is text post types and a numeric interval");
    }
    expect(postTypes.default).toBe("page,post");
    expect(interval.default).toBe(0);
    expect(resolvedIntervalSeconds(interval.default ?? 0)).toBeNull();
  });

  it("raises a polling installation to the declared floor", () => {
    expect(resolvedIntervalSeconds(30)).toBe(60);
    expect(resolvedIntervalSeconds(900)).toBe(900);
  });

  it("runs a backfill against the source that owns the checkpoint", () => {
    const source = manifest.contributions[0];
    if (source.kind !== "document_source") throw new Error("site_content must be a document source");
    expect(source.syncModes).toContain("backfill");
    expect(source.backfill?.checkpointCollection).toBe("sync_state");
    const request = invocationRequestSchema.parse({
      protocolVersion: 1,
      invocationId: "3c9d0e11-2222-4333-8444-555566667777",
      installationId: "1d2e3f40-1111-4222-8333-444455556666",
      releaseDigest: manifest.artifact.digest,
      contributionId: source.id,
      executionClass: "scheduled_task",
      inputSchemaVersion: source.inputSchemaVersion,
      attempt: 1,
      idempotencyKey: "backfill:2026-09-06",
      deadlineAt: "2026-09-06T12:10:00.000Z",
      capabilitySession: { token: "opaque-session-token", expiresAt: "2026-09-06T12:10:00.000Z" },
      input: { kind: "backfill", requestId: "backfill-1", checkpoint: { cursor: "2026-04-18T07:30:00Z" } },
    });
    expect(request.input.kind).toBe("backfill");
  });
});
