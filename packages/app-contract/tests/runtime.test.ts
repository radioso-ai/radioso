import { describe, expect, it, vi } from "vitest";

import {
  appErrorCodes,
  base64BodySchema,
  healthResponseSchema,
  hostCapabilityCallSchema,
  hostCapabilityRequestSchema,
  hostCapabilityResponseSchema,
  invocationOutcomes,
  invocationRequestSchema,
  invocationResponseSchema,
  invocationOutputSchema,
  MAX_BASE64_DECODED_BYTES,
  MAX_EGRESS_QUERY_BYTES,
  MAX_EGRESS_QUERY_ENTRIES,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_HEADER_ENTRIES,
  MAX_JSON_SERIALIZED_BYTES,
  MAX_JSON_STRING_LENGTH,
  RUNTIME_PROTOCOL_VERSION,
} from "../src/index.js";

const INVOCATION_ID = "8b1f6f2a-6f6f-4a3f-9c4a-2f0d0f8a1b21";

const requestHeader = {
  protocolVersion: 1,
  invocationId: INVOCATION_ID,
  installationId: "1d2e3f40-1111-4222-8333-444455556666",
  releaseDigest: `sha256:${"a".repeat(64)}`,
  contributionId: "content_push",
  inputSchemaVersion: 1,
  attempt: 1,
  idempotencyKey: "delivery:6f0f1c2d",
  deadlineAt: "2026-09-06T12:00:30.000Z",
  capabilitySession: { token: "opaque-session-token", expiresAt: "2026-09-06T12:00:30.000Z" },
  context: { configuration: { site_url: "https://example.com", post_types: "page,post", poll_interval_sec: 0 } },
};

const webhookInput = {
  kind: "webhook",
  deliveryId: "6f0f1c2d",
  receivedAt: "2026-09-06T12:00:00.000Z",
  headers: { "X-Radioso-Signature": "sha256=abc" },
  body: { encoding: "base64", data: "eyJldmVudCI6InB1Ymxpc2hlZCJ9" },
};

describe("invocation request", () => {
  it("pins the protocol version to a literal", () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe(1);
    expect(
      invocationRequestSchema.safeParse({
        ...requestHeader,
        protocolVersion: 2,
        executionClass: "external_webhook",
        input: webhookInput,
      }).success,
    ).toBe(false);
  });

  it("carries the release and input-schema identity the work was queued against", () => {
    const parsed = invocationRequestSchema.parse({
      ...requestHeader,
      executionClass: "external_webhook",
      input: webhookInput,
    });
    expect(parsed.releaseDigest).toBe(requestHeader.releaseDigest);
    expect(parsed.inputSchemaVersion).toBe(1);
    expect(parsed.capabilitySession.token).toBe("opaque-session-token");
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

  it("refuses an input kind the execution class does not carry", () => {
    expect(
      invocationRequestSchema.safeParse({
        ...requestHeader,
        executionClass: "external_webhook",
        input: {
          kind: "scheduled",
          occurrenceId: "o1",
          scheduledFor: "2026-09-06T12:00:00.000Z",
        },
      }).success,
    ).toBe(false);
    expect(
      invocationRequestSchema.safeParse({
        ...requestHeader,
        executionClass: "scheduled_task",
        input: webhookInput,
      }).success,
    ).toBe(false);
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

  it("bounds a webhook body to real base64 under a decoded ceiling", () => {
    expect(base64BodySchema.safeParse({ encoding: "base64", data: "not base64!" }).success).toBe(false);
    expect(base64BodySchema.safeParse({ encoding: "base64", data: "abcde" }).success).toBe(false);
    expect(
      base64BodySchema.safeParse({
        encoding: "base64",
        data: "A".repeat(Math.ceil((MAX_BASE64_DECODED_BYTES + 1024) / 3) * 4),
      }).success,
    ).toBe(false);
  });

  it("carries the validated configuration the App runs against", () => {
    const parsed = invocationRequestSchema.parse({
      ...requestHeader,
      executionClass: "external_webhook",
      input: webhookInput,
    });
    expect(parsed.context.configuration["post_types"]).toBe("page,post");
    expect(parsed.context.configuration["poll_interval_sec"]).toBe(0);
  });

  it("refuses an invocation with no configuration context at all", () => {
    const { context: _context, ...withoutContext } = requestHeader;
    expect(
      invocationRequestSchema.safeParse({
        ...withoutContext,
        executionClass: "external_webhook",
        input: webhookInput,
      }).success,
    ).toBe(false);
  });

  it("keeps the context to declared keys, scalar values, and a bounded size", () => {
    const withContext = (configuration: Record<string, unknown>): boolean =>
      invocationRequestSchema.safeParse({
        ...requestHeader,
        context: { configuration },
        executionClass: "external_webhook",
        input: webhookInput,
      }).success;
    expect(withContext({ "Not A Key": "x" })).toBe(false);
    expect(withContext({ nested: { value: 1 } })).toBe(false);
    expect(withContext({ site_url: "x".repeat(4097) })).toBe(false);
    expect(
      withContext(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field_${index}`, "v"]))),
    ).toBe(false);
    expect(
      invocationRequestSchema.safeParse({
        ...requestHeader,
        context: { configuration: {}, secrets: {} },
        executionClass: "external_webhook",
        input: webhookInput,
      }).success,
    ).toBe(false);
  });

  it("bounds how many headers one delivery may carry", () => {
    const headers = Object.fromEntries(
      Array.from({ length: MAX_HEADER_ENTRIES + 1 }, (_, index) => [`X-Header-${index}`, "v"]),
    );
    expect(
      invocationRequestSchema.safeParse({
        ...requestHeader,
        executionClass: "external_webhook",
        input: { ...webhookInput, headers },
      }).success,
    ).toBe(false);
  });
});

describe("health response", () => {
  it("reports readiness and the contributions the artifact implements", () => {
    const parsed = healthResponseSchema.parse({
      protocolVersion: 1,
      ready: true,
      implementedContributionIds: ["site_content", "content_push", "content_poll"],
    });
    expect(parsed.implementedContributionIds).toHaveLength(3);
    expect(healthResponseSchema.safeParse({ protocolVersion: 2, ready: true, implementedContributionIds: [] }).success).toBe(
      false,
    );
  });
});

describe("invocation response", () => {
  const responseHeader = { protocolVersion: 1, invocationId: INVOCATION_ID };

  it("names the closed outcome catalog", () => {
    expect([...invocationOutcomes]).toEqual([
      "succeeded",
      "invalid_request",
      "denied",
      "unavailable",
      "rate_limited",
      "retryable_failure",
      "terminal_failure",
      "timed_out",
      "cancelled",
    ]);
  });

  it("accepts a success carrying its output schema version, output, and checkpoint", () => {
    const parsed = invocationResponseSchema.parse({
      ...responseHeader,
      outcome: "succeeded",
      outputSchemaVersion: 1,
      output: { counts: { ingested: 3, deleted: 1, skipped: 0 } },
      checkpoint: { cursor: "2026-09-06T12:00:00.000Z" },
    });
    expect(parsed.outcome).toBe("succeeded");
  });

  it("keeps success and failure mutually exclusive", () => {
    expect(
      invocationResponseSchema.safeParse({
        ...responseHeader,
        outcome: "succeeded",
        outputSchemaVersion: 1,
        output: {},
        error: { code: "internal", message: "both at once" },
      }).success,
    ).toBe(false);
    expect(
      invocationResponseSchema.safeParse({
        ...responseHeader,
        outcome: "terminal_failure",
        error: { code: "internal", message: "over" },
        checkpoint: { cursor: "a" },
      }).success,
    ).toBe(false);
    expect(
      invocationResponseSchema.safeParse({
        ...responseHeader,
        outcome: "denied",
        error: { code: "denied", message: "no grant" },
        retryAfterSeconds: 30,
      }).success,
    ).toBe(false);
  });

  it("lets an outcome worth retrying report progress and ask the host to wait", () => {
    const parsed = invocationResponseSchema.parse({
      ...responseHeader,
      outcome: "rate_limited",
      error: { code: "unavailable", message: "site is throttling" },
      retryAfterSeconds: 30,
      checkpoint: { cursor: "page-3" },
    });
    expect(parsed.outcome).toBe("rate_limited");
    expect(
      invocationResponseSchema.safeParse({ ...responseHeader, outcome: "retryable_failure" }).success,
    ).toBe(false);
  });

  it("bounds the whole output rather than each of its values on its own", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`key_${index}`, "x".repeat(MAX_JSON_STRING_LENGTH)]),
    );
    expect(invocationOutputSchema.safeParse({ counts: { ingested: 1, deleted: 0, skipped: 0 } }).success).toBe(
      true,
    );
    expect(invocationOutputSchema.safeParse(wide).success).toBe(false);
    expect(
      invocationResponseSchema.safeParse({
        ...responseHeader,
        outcome: "succeeded",
        outputSchemaVersion: 1,
        output: wide,
      }).success,
    ).toBe(false);
    expect(
      invocationOutputSchema.safeParse({ report: "x".repeat(MAX_JSON_STRING_LENGTH) }).success,
    ).toBe(true);
  });

  it("bounds the error message so a payload cannot be echoed back", () => {
    expect(MAX_ERROR_MESSAGE_LENGTH).toBe(512);
    expect(
      invocationResponseSchema.safeParse({
        ...responseHeader,
        outcome: "terminal_failure",
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
        sourceContributionId: "site_content",
        document: {
          externalDocumentId: "wp_post_12",
          title: "Hello",
          content: { format: "html", value: "<p>Hello</p>" },
          sourceUrl: "https://example.com/hello",
          indexedFields: { sku: "A-1", price: 9.5, ISBN: "9788894000000" },
          metadata: { wp_post_type: "post", author: "Ada Lovelace" },
          publishedAt: "2026-09-01T08:00:00.000Z",
          modifiedAt: "2026-09-02T08:00:00.000Z",
          author: "Ada Lovelace",
        },
      },
      {
        capability: "documents.delete",
        sourceContributionId: "site_content",
        externalDocumentId: "wp_post_12",
      },
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
      const parsed = hostCapabilityRequestSchema.safeParse(request);
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    }
  });

  it("requires a document effect to name the source that owns the namespace", () => {
    expect(
      hostCapabilityRequestSchema.safeParse({
        capability: "documents.delete",
        externalDocumentId: "wp_post_12",
      }).success,
    ).toBe(false);
  });

  it("keeps an egress path origin-relative", () => {
    const reject = (path: string): boolean =>
      hostCapabilityRequestSchema.safeParse({
        capability: "egress.fetch",
        destination: "site",
        method: "GET",
        path,
      }).success;
    expect(reject("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(reject("//169.254.169.254/latest/meta-data/")).toBe(false);
    expect(reject("\\\\evil.example/")).toBe(false);
    expect(reject("/wp-json/wp/v2/posts#fragment")).toBe(false);
    expect(reject("wp-json/wp/v2/posts")).toBe(false);
    expect(reject("/wp-json/wp/v2/posts")).toBe(true);
  });

  it("bounds an egress query by entry count and encoded size", () => {
    const withQuery = (query: Record<string, string>): boolean =>
      hostCapabilityRequestSchema.safeParse({
        capability: "egress.fetch",
        destination: "site",
        method: "GET",
        path: "/wp-json/wp/v2/posts",
        query,
      }).success;
    expect(withQuery({ modified_after: "2026-09-05T00:00:00", per_page: "100" })).toBe(true);
    expect(
      withQuery(
        Object.fromEntries(
          Array.from({ length: MAX_EGRESS_QUERY_ENTRIES + 1 }, (_, index) => [`k${index}`, "v"]),
        ),
      ),
    ).toBe(false);
    expect(
      withQuery(
        Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            `k${index}`,
            "x".repeat(Math.ceil(MAX_EGRESS_QUERY_BYTES / 8)),
          ]),
        ),
      ),
    ).toBe(false);
  });

  it("refuses an oversized payload without ever serializing it", () => {
    const serialize = vi.spyOn(JSON, "stringify");
    const oversized = { payload: "x".repeat(100_000_000) };
    const startedAt = performance.now();
    const parsed = invocationOutputSchema.safeParse(oversized);
    const elapsedMs = performance.now() - startedAt;
    serialize.mockRestore();
    expect(parsed.success).toBe(false);
    expect(serialize).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(2000);
    expect(MAX_JSON_SERIALIZED_BYTES).toBe(64 * 1024);
  });

  it("rejects a capability outside the union", () => {
    expect(hostCapabilityRequestSchema.safeParse({ capability: "documents.list" }).success).toBe(false);
  });

  it("carries the protocol version, invocation, session, and idempotency id on every call", () => {
    const call = {
      protocolVersion: 1,
      invocationId: INVOCATION_ID,
      capabilitySession: "opaque-session-token",
      requestId: "wp_post_12:published",
      request: { capability: "storage.get", request: { collection: "sync_state", key: "site" } },
    };
    expect(hostCapabilityCallSchema.parse(call).requestId).toBe("wp_post_12:published");
    for (const missing of ["protocolVersion", "invocationId", "capabilitySession", "requestId"]) {
      const partial: Record<string, unknown> = { ...call };
      delete partial[missing];
      expect(hostCapabilityCallSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("ties a successful result to the capability that produced it", () => {
    expect(
      hostCapabilityResponseSchema.parse({
        ok: true,
        capability: "documents.ingest",
        result: { externalDocumentId: "wp_post_12", outcome: "created" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      hostCapabilityResponseSchema.parse({ ok: true, capability: "storage.put", result: { version: 2 } }),
    ).toMatchObject({ ok: true });
    expect(
      hostCapabilityResponseSchema.safeParse({ ok: true, capability: "storage.put", result: { deleted: true } })
        .success,
    ).toBe(false);
    expect(hostCapabilityResponseSchema.safeParse({ ok: true, result: { version: 2 } }).success).toBe(false);
  });

  it("parses the failure arm and refuses an error code outside the vocabulary", () => {
    expect(
      hostCapabilityResponseSchema.parse({
        ok: false,
        error: { code: "destination_denied", message: "host not declared" },
      }),
    ).toMatchObject({ ok: false });
    expect(
      hostCapabilityResponseSchema.safeParse({ ok: false, error: { code: "teapot", message: "no" } }).success,
    ).toBe(false);
  });
});
