import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  hostCapabilityCallSchema,
  invocationRequestSchema,
  releaseAValidationPolicy,
  requiredConnectionSlotsFor,
  validateConfigurationValues,
  validateManifest,
  webhookInvocationInputSchema,
  type AppManifest,
} from "../src/index.js";

/**
 * The manifest says what the WordPress App may declare. This says the App can
 * still carry what the companion plugin already sends: the exact bytes it signs,
 * the same `wp_post_<id>` identity, the same rendered HTML including its facts
 * block, the same author and date handling, and the same site-owned field map —
 * including a key like `ISBN` that a catalogue registers in its own case.
 *
 * The deliveries are recorded, not rebuilt here. `tests/fixtures/wordpress-companion/README.md`
 * says how they were produced and what `wp_json_encode()` does that
 * `JSON.stringify` does not.
 */
const fixturePath = fileURLToPath(new URL("../fixtures/reference/wordpress.manifest.json", import.meta.url));
const fixtureResult = validateManifest(
  JSON.parse(readFileSync(fixturePath, "utf8")) as unknown,
  releaseAValidationPolicy,
);
if (!fixtureResult.ok) throw new Error("the reference WordPress manifest must validate");
const manifest: AppManifest = fixtureResult.manifest;

const SOURCE_CONTRIBUTION_ID = "site_content";
const INVOCATION_ID = "8b1f6f2a-6f6f-4a3f-9c4a-2f0d0f8a1b21";

interface RecordedDelivery {
  event: "published" | "updated" | "deleted";
  secret: string;
  signature: string;
  signatureHeader: string;
  eventHeader: string;
  body: string;
}

const recorded = (name: string): RecordedDelivery =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/wordpress-companion/${name}.json`, import.meta.url)), "utf8"),
  ) as RecordedDelivery;

const publishedPost = recorded("post-published");
const updatedPost = recorded("post-updated");
const deletedPost = recorded("post-deleted");
const defaultProduct = recorded("product-default");
const filteredProduct = recorded("product-filtered-isbn");

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
  event: RecordedDelivery["event"];
  site_url: string;
  post: PluginPost;
}

const webhookContribution = manifest.contributions[1];
if (webhookContribution.kind !== "external_webhook_handler") {
  throw new Error("content_push must be a webhook handler");
}
const { signatureHeader, signaturePrefix } = webhookContribution.authentication;

const deliveryFor = (delivery: RecordedDelivery): unknown => ({
  kind: "webhook",
  deliveryId: `wp-${delivery.event}-${delivery.signature.slice(-12)}`,
  receivedAt: "2026-09-06T12:00:00.000Z",
  headers: {
    "Content-Type": "application/json",
    [delivery.signatureHeader]: delivery.signature,
    [delivery.eventHeader]: delivery.event,
  },
  body: { encoding: "base64", data: Buffer.from(delivery.body, "utf8").toString("base64") },
});

/**
 * Verifies the recorded signature over the bytes that came out of the base64
 * round trip. Nothing here re-encodes the payload, because a verifier that did
 * would accept deliveries the plugin never sent.
 */
const verifiedBodyOf = (delivery: RecordedDelivery): PluginPayload => {
  const parsed = webhookInvocationInputSchema.parse(deliveryFor(delivery));
  const raw = Buffer.from(parsed.body.data, "base64");
  const presented = parsed.headers[signatureHeader];
  expect(presented?.startsWith(signaturePrefix ?? "")).toBe(true);
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", delivery.secret).update(raw).digest("hex")}`,
    "utf8",
  );
  const provided = Buffer.from(presented ?? "", "utf8");
  expect(provided.length).toBe(expected.length);
  expect(timingSafeEqual(provided, expected)).toBe(true);
  expect(raw.toString("utf8")).toBe(delivery.body);
  return JSON.parse(raw.toString("utf8")) as PluginPayload;
};

/** WordPress stores GMT dates as MySQL datetimes; an instant needs both marks. */
const asInstant = (wordpressGmt: string): string => `${wordpressGmt.replace(" ", "T")}Z`;
const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/u;

/** What the App would ask the host to write, given one verified push. */
const ingestCallFor = (payload: PluginPayload): unknown => {
  const post = payload.post;
  const isoDay = ISO_DAY.exec(post.date_gmt)?.[1];
  return {
    protocolVersion: 1,
    invocationId: INVOCATION_ID,
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

const ingestRequestFor = (delivery: RecordedDelivery) => {
  const call = hostCapabilityCallSchema.parse(ingestCallFor(verifiedBodyOf(delivery)));
  if (call.request.capability !== "documents.ingest") throw new Error("expected an ingest call");
  return { call, request: call.request };
};

describe("companion plugin interoperability", () => {
  it("verifies each recorded delivery over the exact bytes, after a base64 round trip", () => {
    for (const delivery of [publishedPost, updatedPost, deletedPost, defaultProduct, filteredProduct]) {
      expect(verifiedBodyOf(delivery).event).toBe(delivery.event);
    }
  });

  it("signs bytes a re-serializing verifier would never reproduce", () => {
    for (const delivery of [publishedPost, defaultProduct]) {
      expect(JSON.stringify(JSON.parse(delivery.body))).not.toBe(delivery.body);
      expect(delivery.body).toContain(String.raw`https:\/\/example.com\/`);
    }
    expect(defaultProduct.body).toContain(String.raw`"regular_price":29.0`);
    expect(defaultProduct.body).toContain(String.raw`Prezzo: 24,50 \u20ac`);
  });

  it("refuses a body whose bytes changed after signing", () => {
    const tampered = publishedPost.body.replace("How we price books", "How we price bugs!");
    expect(tampered.length).toBe(publishedPost.body.length);
    const signature = `sha256=${createHmac("sha256", publishedPost.secret).update(Buffer.from(tampered, "utf8")).digest("hex")}`;
    expect(signature).not.toBe(publishedPost.signature);
  });

  it("maps a published push onto a documents.ingest call the contract accepts", () => {
    const { request } = ingestRequestFor(publishedPost);
    expect(request.sourceContributionId).toBe(SOURCE_CONTRIBUTION_ID);
    expect(request.document.externalDocumentId).toBe("wp_post_4211");
    expect(request.document.content.format).toBe("html");
    expect(request.document.author).toBe("Ada Lovelace");
    expect(request.document.publishedAt).toBe("2026-09-01T08:00:00Z");
    expect(request.document.modifiedAt).toBe("2026-09-01T08:00:00Z");
    expect(request.document.metadata).toMatchObject({
      wp_post_type: "post",
      wp_status: "publish",
      dateFrom: "2026-09-01",
    });
  });

  it("keeps one external id across an edit and moves only the modification time", () => {
    const published = ingestRequestFor(publishedPost).request;
    const updated = ingestRequestFor(updatedPost).request;
    expect(updated.document.externalDocumentId).toBe(published.document.externalDocumentId);
    expect(updated.document.publishedAt).toBe(published.document.publishedAt);
    expect(updated.document.modifiedAt).toBe("2026-09-02T09:15:00Z");
  });

  it("carries a default WooCommerce product's discount and its rendered facts block", () => {
    const { request } = ingestRequestFor(defaultProduct);
    expect(request.document.indexedFields).toEqual({
      sku: "AE-1029",
      price: 24.5,
      regular_price: 29,
      sale_price: 24.5,
      currency: "EUR",
      on_sale: true,
      stock_status: "instock",
    });
    expect(request.document.content.value).toContain('<ul class="radioso-facts">');
    expect(request.document.content.value).toContain("<li>Prezzo di listino: 29,00 €</li>");
    expect(request.document.author).toBeUndefined();
  });

  it("keeps a filter-added key in the case the catalogue spells it, inside the declared ceiling", () => {
    const { request } = ingestRequestFor(filteredProduct);
    expect(request.document.indexedFields?.["ISBN"]).toBe("9788894000000");
    expect(request.document.author).toBe("Dante Alighieri");
    expect(request.document.content.value).toContain("<li>Autore: Dante Alighieri</li>");
    const source = manifest.contributions[0];
    if (source.kind !== "document_source") throw new Error("site_content must be a document source");
    if (source.indexedFields.policy !== "dynamic") throw new Error("site_content owns a dynamic vocabulary");
    expect(Object.keys(request.document.indexedFields ?? {}).length).toBeLessThanOrEqual(
      source.indexedFields.maxFields,
    );
  });

  it("repeats one requestId across retries of the same logical effect", () => {
    expect(ingestRequestFor(defaultProduct).call.requestId).toBe(
      ingestRequestFor(defaultProduct).call.requestId,
    );
  });

  it("maps a deleted push onto a documents.delete call in the same namespace", () => {
    const payload = verifiedBodyOf(deletedPost);
    const call = hostCapabilityCallSchema.parse({
      protocolVersion: 1,
      invocationId: INVOCATION_ID,
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
    expect(payload.post.status).toBe("trash");
  });
});

const PUSH_ONLY_CONTRIBUTIONS = ["site_content", "content_push"];
const POLLING_CONTRIBUTIONS = ["site_content", "content_push", "content_poll"];

describe("installation shapes the WordPress App has to cover", () => {
  it("installs a push-only site with no site credentials at all", () => {
    const validated = validateConfigurationValues(manifest, {
      site_url: "https://example.com",
      post_types: "page,post",
      poll_interval_sec: 0,
    });
    expect(validated.ok ? [] : validated.issues).toEqual([]);
    expect(requiredConnectionSlotsFor(manifest, PUSH_ONLY_CONTRIBUTIONS)).toEqual(["webhook_secret"]);
  });

  it("asks for site credentials once the polling contribution is active", () => {
    expect(requiredConnectionSlotsFor(manifest, POLLING_CONTRIBUTIONS)).toEqual([
      "webhook_secret",
      "site_credentials",
    ]);
  });

  it("reads the REST API anonymously until the operator binds the credential", () => {
    const destination = manifest.destinations[0];
    expect(destination.credentials).toEqual({
      slot: "site_credentials",
      application: {
        mode: "http_basic",
        usernameField: "wp_username",
        passwordField: "wp_application_password",
      },
      required: false,
    });
  });

  it("leaves a push-only installation with no schedule and raises a polling one to the floor", () => {
    const interval = manifest.configuration.fields.find((field) => field.key === "poll_interval_sec");
    const postTypes = manifest.configuration.fields.find((field) => field.key === "post_types");
    if (postTypes?.type !== "text" || interval?.type !== "number") {
      throw new Error("the default installation is text post types and a numeric interval");
    }
    expect(postTypes.default).toBe("page,post");
    expect(interval.default).toBe(0);

    const poll = manifest.contributions[2];
    if (poll.kind !== "scheduled_task") throw new Error("content_poll must be a scheduled task");
    if (poll.schedule.kind !== "interval_from_configuration") throw new Error("content_poll reads its interval");
    expect(poll.schedule.disabledValue).toBe(interval.default);
    expect(poll.schedule.disabledValue).toBeLessThan(poll.schedule.minSeconds);
    expect(poll.schedule.minSeconds).toBe(60);
  });

  it("runs a backfill against the source that owns the checkpoint, carrying the configured post types", () => {
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
      context: {
        configuration: {
          site_url: "https://example.com",
          post_types: "page,post,product",
          poll_interval_sec: 0,
        },
      },
      input: { kind: "backfill", requestId: "backfill-1", checkpoint: { cursor: "2026-04-18 07:30:00" } },
    });
    expect(request.input.kind).toBe("backfill");
    expect(request.context.configuration["post_types"]).toBe("page,post,product");
  });
});
