import { describe, expect, it, vi } from "vitest";

import {
  appErrorCodes,
  base64BodySchema,
  boundedJsonValueSchema,
  healthResponseSchema,
  hostCapabilityCallSchema,
  hostCapabilityRequestSchema,
  hostCapabilityResponseSchema,
  invocationOutcomes,
  egressFetchRequestSchema,
  invocationRequestSchema,
  invocationResponseSchema,
  invocationOutputSchema,
  MAX_BASE64_DECODED_BYTES,
  MAX_EGRESS_QUERY_BYTES,
  MAX_EGRESS_QUERY_ENTRIES,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_HEADER_ENTRIES,
  MAX_JSON_OBJECT_KEYS,
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

  it("keeps an egress path below the destination's prefix, encoded or not", () => {
    const accepts = (path: string): boolean =>
      hostCapabilityRequestSchema.safeParse({
        capability: "egress.fetch",
        destination: "site",
        method: "GET",
        path,
      }).success;
    for (const path of [
      "/../wp-admin",
      "/wp-json/../../wp-admin",
      "/%2e%2e/wp-admin",
      "/%2E%2E/wp-admin",
      "/wp-json/%2e/posts",
      "/wp-json/./posts",
      "/wp-json/..",
      "/wp-json/.",
      "/wp-json/wp/v2/posts?per_page=100",
      "/wp-json/%2e%2e",
    ]) {
      expect(accepts(path)).toBe(false);
    }
    for (const path of ["/wp-json/wp/v2/posts", "/wp-json/...posts", "/wp-json/a%2ebc", "/wp-json/v2.0/posts"]) {
      expect(accepts(path)).toBe(true);
    }
  });

  it("refuses a body on a method that carries none", () => {
    const withBody = (method: string): boolean =>
      hostCapabilityRequestSchema.safeParse({
        capability: "egress.fetch",
        destination: "site",
        method,
        path: "/wp-json/wp/v2/posts",
        body: { encoding: "base64", data: "eyJhIjoxfQ==" },
      }).success;
    expect(withBody("GET")).toBe(false);
    expect(withBody("HEAD")).toBe(false);
    expect(withBody("POST")).toBe(true);
    expect(
      egressFetchRequestSchema.safeParse({
        capability: "egress.fetch",
        destination: "site",
        method: "GET",
        path: "/wp-json/wp/v2/posts",
        body: { encoding: "base64", data: "eyJhIjoxfQ==" },
      }).success,
    ).toBe(false);
  });

  it("holds a header value to what an HTTP field value may carry", () => {
    const withHeaderValue = (value: string): boolean =>
      hostCapabilityRequestSchema.safeParse({
        capability: "egress.fetch",
        destination: "site",
        method: "GET",
        path: "/wp-json/wp/v2/posts",
        headers: { "X-Radioso-Note": value },
      }).success;
    expect(withHeaderValue("application/json")).toBe(true);
    expect(withHeaderValue("token\tvalue")).toBe(true);
    expect(withHeaderValue("caf\u00e9")).toBe(true);
    expect(withHeaderValue("value\r\nX-Injected: 1")).toBe(false);
    expect(withHeaderValue("value\n")).toBe(false);
    expect(withHeaderValue("value\u0000")).toBe(false);
    expect(withHeaderValue("value\u007f")).toBe(false);
    expect(withHeaderValue("value \u{1f600}")).toBe(false);
  });

  it("refuses an oversized header map on breadth alone, before it reads an entry", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`X-Header-${index}`, "value\r\ninjected"]),
    );
    const parsed = hostCapabilityRequestSchema.safeParse({
      capability: "egress.fetch",
      destination: "site",
      method: "GET",
      path: "/wp-json/wp/v2/posts",
      headers: wide,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([
      `At most ${MAX_HEADER_ENTRIES} headers`,
    ]);
  });

  it("refuses an oversized query map on breadth alone, before it reads an entry", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`k${index}`, "x".repeat(4096)]),
    );
    const parsed = hostCapabilityRequestSchema.safeParse({
      capability: "egress.fetch",
      destination: "site",
      method: "GET",
      path: "/wp-json/wp/v2/posts",
      query: wide,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([
      `A query may hold at most ${MAX_EGRESS_QUERY_ENTRIES} entries`,
    ]);
  });

  it("charges one = inside a pair and one & between pairs, to the byte", () => {
    const atCeiling = {
      a: "x".repeat(2046),
      b: "x".repeat(2045),
      c: "x".repeat(2045),
      d: "x".repeat(2045),
    };
    const oneOver = { ...atCeiling, a: "x".repeat(2047) };
    expect(new URLSearchParams(atCeiling).toString().length).toBe(MAX_EGRESS_QUERY_BYTES);
    expect(new URLSearchParams(oneOver).toString().length).toBe(MAX_EGRESS_QUERY_BYTES + 1);
    const withQuery = (query: Record<string, string>): boolean =>
      hostCapabilityRequestSchema.safeParse({
        capability: "egress.fetch",
        destination: "site",
        method: "GET",
        path: "/wp-json/wp/v2/posts",
        query,
      }).success;
    expect(withQuery(atCeiling)).toBe(true);
    expect(withQuery(oneOver)).toBe(false);
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

  it("refuses an output one string longer than the ceiling allows", () => {
    expect(MAX_JSON_SERIALIZED_BYTES).toBe(64 * 1024);
    expect(invocationOutputSchema.safeParse({ payload: "x".repeat(MAX_JSON_STRING_LENGTH + 1) }).success).toBe(
      false,
    );
  });

  it("refuses an output wider than the key ceiling, one key past it", () => {
    const atCeiling = Object.fromEntries(
      Array.from({ length: MAX_JSON_OBJECT_KEYS }, (_, index) => [`k${index}`, 1]),
    );
    const oneWider = { ...atCeiling, [`k${MAX_JSON_OBJECT_KEYS}`]: 1 };
    expect(MAX_JSON_OBJECT_KEYS).toBe(256);
    expect(invocationOutputSchema.safeParse(atCeiling).success).toBe(true);
    expect(invocationOutputSchema.safeParse(oneWider).success).toBe(false);
  });

  it("charges a lone surrogate the six bytes JSON writes it in, not the two it occupies", () => {
    // Two full-length lone-surrogate strings are 16,384 UTF-16 code units and
    // serialize to about 96 KiB, because `JSON.stringify` writes each half as a
    // six-character `\\uXXXX` escape.
    const lone = "\ud800".repeat(MAX_JSON_STRING_LENGTH);
    expect(invocationOutputSchema.safeParse({ p: lone, q: lone }).success).toBe(false);
    expect(Buffer.byteLength(JSON.stringify({ p: lone, q: lone }), "utf8")).toBeGreaterThan(
      MAX_JSON_SERIALIZED_BYTES,
    );
    expect(invocationOutputSchema.safeParse({ p: lone }).success).toBe(true);
  });

  it("accepts an output of exactly the ceiling and refuses it one byte later", () => {
    const lone = "\ud800".repeat(MAX_JSON_STRING_LENGTH);
    const atCeiling = { p: [lone, "x".repeat(8184), "x".repeat(8184)] };
    const oneOver = { p: [lone, "x".repeat(8184), "x".repeat(8185)] };
    expect(Buffer.byteLength(JSON.stringify(atCeiling), "utf8")).toBe(MAX_JSON_SERIALIZED_BYTES);
    expect(Buffer.byteLength(JSON.stringify(oneOver), "utf8")).toBe(MAX_JSON_SERIALIZED_BYTES + 1);
    expect(invocationOutputSchema.safeParse(atCeiling).success).toBe(true);
    expect(invocationOutputSchema.safeParse(oneOver).success).toBe(false);
  });

  it("charges a surrogate pair the four UTF-8 bytes it encodes to", () => {
    const pairs = "\u{1f600}".repeat(MAX_JSON_STRING_LENGTH / 2);
    const payload = { p: [pairs, "x".repeat(8192)] };
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(MAX_JSON_SERIALIZED_BYTES);
    expect(invocationOutputSchema.safeParse(payload).success).toBe(true);
  });

  it("refuses a query whose value is not encodable text, rather than throwing out of the encoder", () => {
    const parsed = hostCapabilityRequestSchema.safeParse({
      capability: "egress.fetch",
      destination: "site",
      method: "GET",
      path: "/wp-json/wp/v2/posts",
      query: { x: "\ud800" },
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps the broker's own headers, and its authorization, out of an App's request", () => {
    const withHeader = (header: string): boolean =>
      hostCapabilityRequestSchema.safeParse({
        capability: "egress.fetch",
        destination: "site",
        method: "GET",
        path: "/wp-json/wp/v2/posts",
        headers: { [header]: "value" },
      }).success;
    expect(withHeader("Accept")).toBe(true);
    for (const header of [
      "Host",
      "content-length",
      "Transfer-Encoding",
      "connection",
      "Upgrade",
      "TE",
      "Trailer",
      "Keep-Alive",
      "Proxy-Authorization",
      "proxy-connection",
      "Proxy-Authenticate",
      "Authorization",
      "authorization",
    ]) {
      expect(withHeader(header)).toBe(false);
    }
  });

  it("refuses an object whose serialized form was never measured, without asking it for one", () => {
    const toJSON = vi.fn(() => "x".repeat(1_000_000));
    const hostile: Record<string, unknown> = { cursor: "page-1" };
    Object.defineProperty(hostile, "toJSON", { value: toJSON, enumerable: false });
    expect(boundedJsonValueSchema.safeParse(hostile).success).toBe(false);
    expect(invocationOutputSchema.safeParse({ payload: hostile }).success).toBe(false);
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("bounds only genuine JSON containers", () => {
    class Report {
      public value = 1;
    }
    class Rows extends Array {}
    const accessor = {};
    Object.defineProperty(accessor, "size", { get: () => 1, enumerable: true, configurable: true });
    for (const value of [
      new Date(),
      new Map([["a", 1]]),
      new Set([1]),
      new Report(),
      new Uint8Array(4),
      new Rows(),
      accessor,
      () => 1,
    ]) {
      expect(boundedJsonValueSchema.safeParse(value).success).toBe(false);
    }
    expect(boundedJsonValueSchema.safeParse({ ok: true, items: [1, "two", null] }).success).toBe(true);
    expect(boundedJsonValueSchema.safeParse({ toJSON: "a field the synced system calls that" }).success).toBe(
      true,
    );
    expect(boundedJsonValueSchema.safeParse(Object.assign(Object.create(null), { ok: true })).success).toBe(
      true,
    );
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
