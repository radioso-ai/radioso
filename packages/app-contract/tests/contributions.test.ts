import { describe, expect, it } from "vitest";

import {
  contributionSchema,
  executionClassForContributionKind,
  hostPermissions,
  releaseAContributionKinds,
  reservedContributionKinds,
} from "../src/index.js";

const header = {
  displayName: "Site content",
  description: "Publishes site content into the workspace.",
  permissions: ["documents.ingest"],
  egressDestinations: [],
  deadlineMs: 30_000,
  availability: "required",
};

const documentSource = {
  ...header,
  id: "site_content",
  kind: "document_source",
  externalIdNamespace: "wp_post",
  syncModes: ["push", "poll", "backfill"],
  contentFormats: ["html"],
  indexedFieldKeys: ["sku", "price"],
  backfill: { checkpointCollection: "sync_state" },
};

const webhookHandler = {
  ...header,
  id: "content_push",
  kind: "external_webhook_handler",
  authentication: {
    kind: "hmac_sha256",
    secretConnectionSlot: "webhook_secret",
    signatureHeader: "X-Radioso-Signature",
    signaturePrefix: "sha256=",
  },
  maxBodyBytes: 2_097_152,
  replayWindowSeconds: 300,
};

const scheduledTask = {
  ...header,
  id: "content_poll",
  kind: "scheduled_task",
  schedule: { kind: "interval_from_configuration", field: "poll_interval_sec", minSeconds: 60 },
  overlapPolicy: "skip",
  maxDurationSeconds: 600,
  retry: { maxAttempts: 5, backoff: { kind: "exponential", baseSeconds: 30, maxSeconds: 900 } },
  checkpointCollection: "sync_state",
};

describe("contribution catalog", () => {
  it("names the Release A kinds and the reserved kinds", () => {
    expect([...releaseAContributionKinds]).toEqual([
      "document_source",
      "external_webhook_handler",
      "scheduled_task",
    ]);
    expect([...reservedContributionKinds]).toEqual([
      "tool",
      "context_provider",
      "event_subscription",
      "ui",
      "pack",
    ]);
  });

  it("names the host permission vocabulary", () => {
    expect([...hostPermissions]).toEqual([
      "documents.ingest",
      "documents.delete",
      "storage.read",
      "storage.write",
      "egress.fetch",
    ]);
  });

  it("accepts a document source", () => {
    expect(contributionSchema.parse(documentSource)).toMatchObject({ kind: "document_source" });
  });

  it("accepts an external webhook handler", () => {
    expect(contributionSchema.parse(webhookHandler)).toMatchObject({
      authentication: { kind: "hmac_sha256" },
    });
  });

  it("accepts a scheduled task with a fixed interval and one read from configuration", () => {
    expect(contributionSchema.parse(scheduledTask)).toMatchObject({ overlapPolicy: "skip" });
    expect(
      contributionSchema.parse({ ...scheduledTask, schedule: { kind: "interval", seconds: 900 } }),
    ).toMatchObject({ schedule: { kind: "interval", seconds: 900 } });
  });

  it("rejects an authentication kind other than hmac_sha256", () => {
    expect(
      contributionSchema.safeParse({
        ...webhookHandler,
        authentication: { ...webhookHandler.authentication, kind: "bearer" },
      }).success,
    ).toBe(false);
  });

  it("rejects a retry backoff whose ceiling is below its base", () => {
    expect(
      contributionSchema.safeParse({
        ...scheduledTask,
        retry: { maxAttempts: 5, backoff: { kind: "exponential", baseSeconds: 900, maxSeconds: 30 } },
      }).success,
    ).toBe(false);
  });

  it("parses a reserved kind by header alone", () => {
    const parsed = contributionSchema.parse({
      ...header,
      id: "answer_tool",
      kind: "tool",
      inputSchema: { type: "object" },
    });
    expect(parsed).toMatchObject({ id: "answer_tool", kind: "tool" });
    expect(parsed).not.toHaveProperty("inputSchema");
  });

  it("rejects a kind outside the catalog", () => {
    expect(contributionSchema.safeParse({ ...header, id: "mystery", kind: "widget" }).success).toBe(false);
  });

  it("derives the execution class from the contribution kind", () => {
    expect(executionClassForContributionKind("external_webhook_handler")).toBe("external_webhook");
    expect(executionClassForContributionKind("scheduled_task")).toBe("scheduled_task");
    expect(executionClassForContributionKind("document_source")).toBe("scheduled_task");
    expect(executionClassForContributionKind("tool")).toBeNull();
  });
});
