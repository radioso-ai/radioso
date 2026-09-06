import { describe, expect, it } from "vitest";

import {
  appErrorCodes,
  hostCapabilityRequestSchema,
  hostCapabilityResponseSchema,
  invocationRequestSchema,
  invocationResponseSchema,
  MAX_ERROR_MESSAGE_LENGTH,
  RUNTIME_PROTOCOL_VERSION,
} from "../src/index.js";

const requestHeader = {
  protocolVersion: 1,
  invocationId: "8b1f6f2a-6f6f-4a3f-9c4a-2f0d0f8a1b21",
  installationId: "1d2e3f40-1111-4222-8333-444455556666",
  contributionId: "content_push",
  attempt: 1,
  idempotencyKey: "delivery:6f0f1c2d",
  deadlineAt: "2026-09-06T12:00:30.000Z",
  identity: { token: "opaque-identity-token", expiresAt: "2026-09-06T12:00:30.000Z" },
};

describe("invocation request", () => {
  it("pins the protocol version to a literal", () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe(1);
    expect(
      invocationRequestSchema.safeParse({
        ...requestHeader,
        protocolVersion: 2,
        executionClass: "external_webhook",
        input: { kind: "webhook", deliveryId: "d1", receivedAt: requestHeader.deadlineAt, headers: {}, body: { encoding: "base64", data: "" } },
      }).success,
    ).toBe(false);
  });

  it("carries a webhook input", () => {
    const parsed = invocationRequestSchema.parse({
      ...requestHeader,
      executionClass: "external_webhook",
      input: {
        kind: "webhook",
        deliveryId: "6f0f1c2d",
        receivedAt: "2026-09-06T12:00:00.000Z",
        headers: { "x-radioso-signature": "sha256=abc" },
        body: { encoding: "base64", data: "eyJldmVudCI6InB1Ymxpc2hlZCJ9" },
      },
    });
    expect(parsed.input.kind).toBe("webhook");
  });

  it("carries a scheduled input with an optional checkpoint", () => {
    const parsed = invocationRequestSchema.parse({
      ...requestHeader,
      contributionId: "content_poll",
      executionClass: "scheduled_task",
      input: {
        kind: "scheduled",
        occurrenceId: "2026-09-06T12:00:00.000Z",
        scheduledFor: "2026-09-06T12:00:00.000Z",
        checkpoint: { cursor: "2026-09-05T00:00:00.000Z" },
      },
    });
    expect(parsed.input).toMatchObject({ kind: "scheduled" });
  });

  it("carries a backfill input", () => {
    const parsed = invocationRequestSchema.parse({
      ...requestHeader,
      contributionId: "site_content",
      executionClass: "scheduled_task",
      input: { kind: "backfill", requestId: "backfill-1" },
    });
    expect(parsed.input).toMatchObject({ kind: "backfill", requestId: "backfill-1" });
  });

  it("rejects an input kind outside the union", () => {
    expect(
      invocationRequestSchema.safeParse({
        ...requestHeader,
        executionClass: "external_webhook",
        input: { kind: "interactive", turnId: "t1" },
      }).success,
    ).toBe(false);
  });
});

describe("invocation response", () => {
  const responseHeader = { protocolVersion: 1, invocationId: requestHeader.invocationId };

  it("accepts a completed response with counts and a checkpoint", () => {
    const parsed = invocationResponseSchema.parse({
      ...responseHeader,
      outcome: "completed",
      output: { checkpoint: { cursor: "2026-09-06T12:00:00.000Z" }, counts: { ingested: 3, deleted: 1, skipped: 0 } },
    });
    expect(parsed.outcome).toBe("completed");
  });

  it("requires an error on a failed or retry outcome", () => {
    expect(invocationResponseSchema.safeParse({ ...responseHeader, outcome: "failed" }).success).toBe(false);
    expect(
      invocationResponseSchema.parse({
        ...responseHeader,
        outcome: "retry",
        error: { code: "unavailable", message: "site unreachable" },
        retryAfterSeconds: 30,
      }).outcome,
    ).toBe("retry");
  });

  it("bounds the error message so a payload cannot be echoed back", () => {
    expect(MAX_ERROR_MESSAGE_LENGTH).toBe(512);
    expect(
      invocationResponseSchema.safeParse({
        ...responseHeader,
        outcome: "failed",
        error: { code: "internal", message: "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 1) },
      }).success,
    ).toBe(false);
  });
});

describe("host capabilities", () => {
  it("names the error code vocabulary", () => {
    expect([...appErrorCodes]).toEqual([
      "denied",
      "not_found",
      "invalid_input",
      "quota_exceeded",
      "version_conflict",
      "destination_denied",
      "deadline_exceeded",
      "unavailable",
      "internal",
    ]);
  });

  it("parses each capability request in the union", () => {
    const requests = [
      {
        capability: "documents.ingest",
        document: {
          externalDocumentId: "wp_post_12",
          title: "Hello",
          content: { format: "html", value: "<p>Hello</p>" },
          sourceUrl: "https://example.com/hello",
          indexedFields: { sku: "A-1", price: 9.5 },
        },
      },
      { capability: "documents.delete", externalDocumentId: "wp_post_12" },
      { capability: "storage.get", request: { collection: "sync_state", key: "site" } },
      { capability: "storage.put", request: { collection: "sync_state", key: "site", record: { cursor: "a" } } },
      { capability: "storage.delete", request: { collection: "sync_state", key: "site" } },
      {
        capability: "storage.query",
        request: { collection: "sync_state", index: "by_updated_at", equals: "a", limit: 10 },
      },
      { capability: "egress.fetch", destination: "site", method: "GET", path: "/wp-json/wp/v2/posts" },
    ];
    for (const request of requests) {
      expect(hostCapabilityRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it("rejects a capability outside the union", () => {
    expect(hostCapabilityRequestSchema.safeParse({ capability: "documents.list" }).success).toBe(false);
  });

  it("parses both arms of the capability response", () => {
    expect(hostCapabilityResponseSchema.parse({ ok: true, result: { version: 2 } })).toMatchObject({ ok: true });
    expect(
      hostCapabilityResponseSchema.parse({ ok: false, error: { code: "destination_denied", message: "host not declared" } }),
    ).toMatchObject({ ok: false });
    expect(
      hostCapabilityResponseSchema.safeParse({ ok: false, error: { code: "teapot", message: "no" } }).success,
    ).toBe(false);
  });
});
