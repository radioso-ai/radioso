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
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
};

const documentSource = {
  ...header,
  id: "site_content",
  kind: "document_source",
  externalIdNamespace: "wp_post",
  syncModes: ["push", "poll", "backfill"],
  contentFormats: ["html"],
  indexedFields: { policy: "declared", keys: ["sku", "price", "ISBN"] },
  backfill: { checkpointCollection: "sync_state" },
};

const webhookHandler = {
  ...header,
  id: "content_push",
  kind: "external_webhook_handler",
  documentSources: ["site_content"],
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
  documentSources: ["site_content"],
  schedule: {
    kind: "interval_from_configuration",
    field: "poll_interval_sec",
    minSeconds: 60,
    disabledValue: 0,
  },
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

  it("parses a reserved kind by header alone, leaving the rest unread rather than rejected", () => {
    const parsed = contributionSchema.parse({
      ...header,
      id: "answer_tool",
      kind: "tool",
      inputSchema: { type: "object" },
    });
    expect(parsed).toMatchObject({ id: "answer_tool", kind: "tool" });
    expect(parsed).toHaveProperty("inputSchema");
  });

  it("rejects an unknown key on a kind this release does run", () => {
    expect(contributionSchema.safeParse({ ...documentSource, physicalTable: "customer_data" }).success).toBe(
      false,
    );
    expect(contributionSchema.safeParse({ ...webhookHandler, allowPrivateNetwork: true }).success).toBe(false);
  });

  it("requires every contribution to version the shapes it reads and writes", () => {
    const { inputSchemaVersion: _input, ...withoutInput } = documentSource;
    const { outputSchemaVersion: _output, ...withoutOutput } = documentSource;
    expect(contributionSchema.safeParse(withoutInput).success).toBe(false);
    expect(contributionSchema.safeParse(withoutOutput).success).toBe(false);
    expect(contributionSchema.safeParse({ ...documentSource, inputSchemaVersion: 0 }).success).toBe(false);
  });

  it("makes a document source say who owns its indexed-field vocabulary", () => {
    expect(contributionSchema.safeParse({ ...documentSource, indexedFields: undefined }).success).toBe(false);
    expect(
      contributionSchema.parse({
        ...documentSource,
        indexedFields: { policy: "dynamic", maxFields: 32 },
      }),
    ).toMatchObject({ indexedFields: { policy: "dynamic", maxFields: 32 } });
    expect(
      contributionSchema.safeParse({ ...documentSource, indexedFields: { policy: "dynamic" } }).success,
    ).toBe(false);
    expect(
      contributionSchema.safeParse({
        ...documentSource,
        indexedFields: { policy: "declared", keys: ["price-max"] },
      }).success,
    ).toBe(false);
    expect(
      contributionSchema.safeParse({
        ...documentSource,
        indexedFields: { policy: "dynamic", maxFields: 65 },
      }).success,
    ).toBe(false);
  });

  it("has a handler that writes documents name the sources it writes through", () => {
    expect(contributionSchema.parse(webhookHandler)).toMatchObject({ documentSources: ["site_content"] });
    const { documentSources: _sources, ...withoutSources } = scheduledTask;
    expect(contributionSchema.parse(withoutSources)).toMatchObject({ documentSources: [] });
  });

  it("lets a configuration-driven schedule name the value that means do not run", () => {
    const parsed = contributionSchema.parse(scheduledTask);
    if (parsed.kind !== "scheduled_task") throw new Error("scheduledTask must parse as a scheduled task");
    if (parsed.schedule.kind !== "interval_from_configuration") {
      throw new Error("scheduledTask must read its interval from configuration");
    }
    expect(parsed.schedule.disabledValue).toBe(0);
    expect(
      contributionSchema.parse({
        ...scheduledTask,
        schedule: { kind: "interval_from_configuration", field: "poll_interval_sec", minSeconds: 60 },
      }),
    ).toMatchObject({ schedule: { minSeconds: 60 } });
  });

  it("lets a contribution name the connection slots it cannot run without", () => {
    expect(contributionSchema.parse(scheduledTask)).toMatchObject({ requiredConnectionSlots: [] });
    expect(
      contributionSchema.parse({ ...scheduledTask, requiredConnectionSlots: ["site_credentials"] }),
    ).toMatchObject({ requiredConnectionSlots: ["site_credentials"] });
    expect(
      contributionSchema.safeParse({
        ...scheduledTask,
        requiredConnectionSlots: ["site_credentials", "site_credentials"],
      }).success,
    ).toBe(false);
  });

  it("refuses a disabled value an operator could pick as a working interval", () => {
    expect(
      contributionSchema.safeParse({
        ...scheduledTask,
        schedule: {
          kind: "interval_from_configuration",
          field: "poll_interval_sec",
          minSeconds: 60,
          disabledValue: 300,
        },
      }).success,
    ).toBe(false);
    expect(
      contributionSchema.safeParse({
        ...scheduledTask,
        schedule: {
          kind: "interval_from_configuration",
          field: "poll_interval_sec",
          minSeconds: 60,
          disabledValue: 59,
        },
      }).success,
    ).toBe(true);
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
