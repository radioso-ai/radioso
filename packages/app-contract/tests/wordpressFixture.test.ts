import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { releaseAValidationPolicy, RUNTIME_PROTOCOL_VERSION, validateManifest } from "../src/index.js";

const fixturePath = fileURLToPath(new URL("../fixtures/reference/wordpress.manifest.json", import.meta.url));
const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("reference WordPress manifest", () => {
  const result = validateManifest(fixture, releaseAValidationPolicy);

  it("validates under the Release A policy", () => {
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("declares the three contributions the WordPress App ships", () => {
    if (!result.ok) throw new Error("fixture must validate");
    expect(result.manifest.contributions.map((contribution) => [contribution.id, contribution.kind])).toEqual([
      ["site_content", "document_source"],
      ["content_push", "external_webhook_handler"],
      ["content_poll", "scheduled_task"],
    ]);
  });

  it("declares the sync_state collection with an index on its update timestamp", () => {
    if (!result.ok) throw new Error("fixture must validate");
    expect(result.manifest.storageCollections).toHaveLength(1);
    const collection = result.manifest.storageCollections[0];
    expect(collection.id).toBe("sync_state");
    expect(collection.recordSchema.fields.map((field) => [field.key, field.type])).toEqual([
      ["cursor", "string"],
      ["updated_at", "timestamp"],
    ]);
    expect(collection.indexes.map((index) => index.field)).toEqual(["updated_at"]);
  });

  it("declares the credential and webhook connection slots", () => {
    if (!result.ok) throw new Error("fixture must validate");
    expect(result.manifest.connections.slots.map((slot) => [slot.id, slot.kind])).toEqual([
      ["site_credentials", "secret_fields"],
      ["webhook_secret", "generated_secret"],
    ]);
    const credentials = result.manifest.connections.slots[0];
    if (credentials.kind !== "secret_fields") throw new Error("site_credentials must be a secret_fields slot");
    expect(credentials.fields.map((field) => [field.key, field.sensitive])).toEqual([
      ["wp_username", false],
      ["wp_application_password", true],
    ]);
  });

  it("binds its only destination to the configured site URL, over either protocol a site serves", () => {
    if (!result.ok) throw new Error("fixture must validate");
    expect(result.manifest.destinations).toHaveLength(1);
    const destination = result.manifest.destinations[0];
    expect(destination.id).toBe("site");
    expect(destination.host).toEqual({ kind: "configuration", field: "site_url" });
    expect(destination.protocols).toEqual(["https", "http"]);
  });

  it("says how the broker authenticates that destination, and that it need not", () => {
    if (!result.ok) throw new Error("fixture must validate");
    expect(result.manifest.destinations[0].credentials).toEqual({
      slot: "site_credentials",
      application: {
        mode: "http_basic",
        usernameField: "wp_username",
        passwordField: "wp_application_password",
      },
      required: false,
    });
  });

  it("requires a connection slot only for the contribution that cannot run without it", () => {
    if (!result.ok) throw new Error("fixture must validate");
    expect(
      result.manifest.contributions.map((contribution) => [
        contribution.id,
        contribution.requiredConnectionSlots,
      ]),
    ).toEqual([
      ["site_content", []],
      ["content_push", ["webhook_secret"]],
      ["content_poll", ["site_credentials"]],
    ]);
  });

  it("declares the runtime protocol its artifact speaks", () => {
    if (!result.ok) throw new Error("fixture must validate");
    expect(result.manifest.runtimeProtocolVersion).toBe(RUNTIME_PROTOCOL_VERSION);
    expect(
      result.manifest.contributions.map((contribution) => [
        contribution.inputSchemaVersion,
        contribution.outputSchemaVersion,
      ]),
    ).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  });

  it("lets the site own its indexed-field vocabulary, bounded by a declared ceiling", () => {
    if (!result.ok) throw new Error("fixture must validate");
    const source = result.manifest.contributions[0];
    if (source.kind !== "document_source") throw new Error("site_content must be a document source");
    expect(source.indexedFields).toEqual({ policy: "dynamic", maxFields: 32 });
    expect(source.externalIdNamespace).toBe("wp_post");
    expect(source.permissions).toEqual([
      "documents.ingest",
      "documents.delete",
      "storage.read",
      "storage.write",
      "egress.fetch",
    ]);
    expect(source.egressDestinations).toEqual(["site"]);
  });

  it("routes every document effect through the one source that owns the namespace", () => {
    if (!result.ok) throw new Error("fixture must validate");
    const push = result.manifest.contributions[1];
    const poll = result.manifest.contributions[2];
    if (push.kind !== "external_webhook_handler") throw new Error("content_push must be a webhook handler");
    if (poll.kind !== "scheduled_task") throw new Error("content_poll must be a scheduled task");
    expect(push.documentSources).toEqual(["site_content"]);
    expect(poll.documentSources).toEqual(["site_content"]);
  });

  it("starts on the post types the companion plugin has always defaulted to", () => {
    if (!result.ok) throw new Error("fixture must validate");
    const postTypes = result.manifest.configuration.fields.find((field) => field.key === "post_types");
    if (postTypes?.type !== "text") throw new Error("post_types must be a text field");
    expect(postTypes.default).toBe("page,post");
  });

  it("verifies pushes with an HMAC over the raw body using the header the companion plugin sends", () => {
    if (!result.ok) throw new Error("fixture must validate");
    const push = result.manifest.contributions[1];
    if (push.kind !== "external_webhook_handler") throw new Error("content_push must be a webhook handler");
    expect(push.authentication).toEqual({
      kind: "hmac_sha256",
      secretConnectionSlot: "webhook_secret",
      signatureHeader: "X-Radioso-Signature",
      signaturePrefix: "sha256=",
    });
    expect(push.maxBodyBytes).toBe(2_097_152);
    expect(push.replayWindowSeconds).toBe(300);
  });

  it("reads its polling interval from configuration with a declared floor", () => {
    if (!result.ok) throw new Error("fixture must validate");
    const poll = result.manifest.contributions[2];
    if (poll.kind !== "scheduled_task") throw new Error("content_poll must be a scheduled task");
    expect(poll.schedule).toEqual({
      kind: "interval_from_configuration",
      field: "poll_interval_sec",
      minSeconds: 60,
      maxSeconds: 86_400,
      disabledValue: 0,
    });
    expect(poll.overlapPolicy).toBe("skip");
    expect(poll.maxDurationSeconds).toBe(600);
    expect(poll.retry).toEqual({
      maxAttempts: 5,
      backoff: { kind: "exponential", baseSeconds: 30, maxSeconds: 900 },
    });
  });

  it("ships the companion plugin as a downloadable asset and a setup guide that explains it", () => {
    if (!result.ok) throw new Error("fixture must validate");
    expect(result.manifest.companionAssets?.map((asset) => asset.fileName)).toEqual(["radioso-sync.zip"]);
    expect(result.manifest.setupGuide?.sections.length).toBeGreaterThanOrEqual(2);
  });
});
