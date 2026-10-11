import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ResendApiClient, type ResendFetch } from "../../../src/modules/mail/adapters/resendApi.js";
import { ResendInboundEmailReceiver } from "../../../src/modules/mail/adapters/resendInboundReceiver.js";
import { InboundFetchError } from "../../../src/modules/mail/public.js";

const RESEND_FIXTURES = fileURLToPath(new URL("../../fixtures/email-channel/resend/", import.meta.url));
const API_KEY = "re_test_SECRETKEY_0123456789";
const CURRENT_SECRET = `whsec_${Buffer.from("current-signing-secret-0000000").toString("base64")}`;
const PREVIOUS_SECRET = `whsec_${Buffer.from("previous-signing-secret-000000").toString("base64")}`;
const EVENT_ID = "msg_2mWZ8uVxJ0bnR9jJm3VbGq5Xr0u";
const EMAIL_ID = "f837952f-d01c-429e-83a5-25c554ec5b18";
const DOWNLOAD_URL = "https://cdn.resend.app/receiving/raw/<signed>";

const fixtureText = (path: string): string => readFileSync(`${RESEND_FIXTURES}${path}`, "utf8");
const fixtureJson = (path: string): Record<string, unknown> =>
  JSON.parse(fixtureText(path)) as Record<string, unknown>;

/** The recorded headers plus the body the GET payload reports (`text: "probe body\n"`). */
const recordedRaw = (): Buffer =>
  Buffer.concat([
    readFileSync(`${RESEND_FIXTURES}api/get-received-email.direct.headers.eml`),
    Buffer.from("\nprobe body\n"),
  ]);

const signatureFor = (secret: string, id: string, timestamp: number, body: Buffer): string => {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64");
  return `v1,${digest}`;
};

const signedRequest = (
  body: Buffer,
  options: { secret?: string; signedAt?: Date; now?: Date } = {},
) => {
  const signedAt = options.signedAt ?? new Date("2026-02-22T23:41:12.500Z");
  const timestamp = Math.floor(signedAt.getTime() / 1000);
  return {
    rawBody: body,
    headers: {
      "svix-id": EVENT_ID,
      "svix-timestamp": String(timestamp),
      "svix-signature": signatureFor(options.secret ?? CURRENT_SECRET, EVENT_ID, timestamp, body),
    },
    now: options.now ?? signedAt,
  };
};

const webhookBody = (path: string, edit?: (payload: Record<string, unknown>) => void): Buffer => {
  const payload = fixtureJson(path);
  edit?.(payload);
  return Buffer.from(JSON.stringify(payload));
};

const dataOf = (payload: Record<string, unknown>): Record<string, unknown> =>
  payload.data as Record<string, unknown>;

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  signal: AbortSignal | null;
}

const fakeResend = (respond: (url: string) => Response | Promise<Response>) => {
  const calls: RecordedCall[] = [];
  const fetch: ResendFetch = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? "GET",
      authorization: headers.get("authorization"),
      signal: init.signal ?? null,
    });
    return respond(url);
  };
  return { calls, fetch };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const receivedRecord = (edit?: (record: Record<string, unknown>) => void): Record<string, unknown> => {
  const record = fixtureJson("api/get-received-email.direct.json");
  edit?.(record);
  return record;
};

const receiverFor = (fetch: ResendFetch, timeoutMs?: number) =>
  new ResendInboundEmailReceiver({
    api: new ResendApiClient({ apiKey: API_KEY, fetch, timeoutMs }),
    signingSecrets: { current: CURRENT_SECRET, previous: PREVIOUS_SECRET },
  });

const happyPath = (record: Record<string, unknown> = receivedRecord()) =>
  fakeResend((url) =>
    url === DOWNLOAD_URL ? new Response(new Uint8Array(recordedRaw())) : json(record),
  );

const fetchFailure = async (receiver: ResendInboundEmailReceiver): Promise<unknown> =>
  receiver.fetchMessage(EMAIL_ID).catch((error: unknown) => error);

const unusedFetch: ResendFetch = async () => {
  throw new Error("verify must not call the provider");
};

describe("Resend inbound receiver: signature", () => {
  const receiver = receiverFor(unusedFetch);

  it("names itself the resend provider", () => {
    expect(receiver.provider).toBe("resend");
  });

  it("accepts an event signed with the current secret", () => {
    const result = receiver.verify(signedRequest(webhookBody("webhooks/email.received.json")));

    expect(result.ok).toBe(true);
  });

  it("accepts an event signed with the previous secret during rotation", () => {
    const body = webhookBody("webhooks/email.received.json");

    const result = receiver.verify(signedRequest(body, { secret: PREVIOUS_SECRET }));

    expect(result.ok).toBe(true);
  });

  it("accepts a header that carries several signatures when one matches", () => {
    const request = signedRequest(webhookBody("webhooks/email.received.json"));
    const headers = {
      ...request.headers,
      "svix-signature": `v1,${Buffer.alloc(32).toString("base64")} ${request.headers["svix-signature"]}`,
    };

    expect(receiver.verify({ ...request, headers }).ok).toBe(true);
  });

  it("verifies the raw bytes as delivered, not a re-serialization", () => {
    const pretty = Buffer.from(fixtureText("webhooks/email.received.json"));

    expect(receiver.verify(signedRequest(pretty)).ok).toBe(true);
  });

  it("reads Svix headers case-insensitively", () => {
    const request = signedRequest(webhookBody("webhooks/email.received.json"));
    const headers = {
      "Svix-Id": request.headers["svix-id"],
      "Svix-Timestamp": request.headers["svix-timestamp"],
      "Svix-Signature": request.headers["svix-signature"],
    };

    expect(receiver.verify({ ...request, headers }).ok).toBe(true);
  });

  it("rejects a body changed after signing", () => {
    const request = signedRequest(webhookBody("webhooks/email.received.json"));
    const tampered = Buffer.from(request.rawBody.toString("utf8").replace("Sending this example", "Changed"));

    expect(receiver.verify({ ...request, rawBody: tampered })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with another secret", () => {
    const stranger = `whsec_${Buffer.from("not-our-secret-at-all-00000000").toString("base64")}`;

    const result = receiver.verify(signedRequest(webhookBody("webhooks/email.received.json"), { secret: stranger }));

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature header without a v1 entry", () => {
    const request = signedRequest(webhookBody("webhooks/email.received.json"));
    const headers = { ...request.headers, "svix-signature": "v1a,abc" };

    expect(receiver.verify({ ...request, headers })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each(["svix-id", "svix-timestamp", "svix-signature"])("reports a missing %s header", (header) => {
    const request = signedRequest(webhookBody("webhooks/email.received.json"));
    const headers: Record<string, string | undefined> = { ...request.headers, [header]: undefined };

    expect(receiver.verify({ ...request, headers })).toEqual({ ok: false, reason: "missing_signature" });
  });

  it.each([
    ["older", -6 * 60 * 1000],
    ["newer", 6 * 60 * 1000],
  ])("rejects a validly signed event %s than five minutes", (_label, skewMs) => {
    const signedAt = new Date("2026-02-22T23:41:12.000Z");
    const request = signedRequest(webhookBody("webhooks/email.received.json"), {
      signedAt,
      now: new Date(signedAt.getTime() - skewMs),
    });

    expect(receiver.verify(request)).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("accepts an event inside the five-minute tolerance", () => {
    const signedAt = new Date("2026-02-22T23:41:12.000Z");
    const request = signedRequest(webhookBody("webhooks/email.received.json"), {
      signedAt,
      now: new Date(signedAt.getTime() + 4 * 60 * 1000),
    });

    expect(receiver.verify(request).ok).toBe(true);
  });

  it("rejects a non-numeric timestamp as a bad signature", () => {
    const request = signedRequest(webhookBody("webhooks/email.received.json"));
    const headers = { ...request.headers, "svix-timestamp": "yesterday" };

    expect(receiver.verify({ ...request, headers })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["not JSON", Buffer.from("{not json")],
    ["no type", webhookBody("webhooks/email.received.json", (payload) => delete payload.type)],
    ["no created_at", webhookBody("webhooks/email.received.json", (payload) => delete payload.created_at)],
    ["no email_id", webhookBody("webhooks/email.received.json", (payload) => delete dataOf(payload).email_id)],
  ])("reports a signed but malformed payload (%s)", (_label, body) => {
    expect(receiver.verify(signedRequest(body))).toEqual({ ok: false, reason: "malformed_payload" });
  });
});

describe("Resend inbound receiver: event kinds", () => {
  const receiver = receiverFor(unusedFetch);
  const verifiedEvent = (body: Buffer) => {
    const result = receiver.verify(signedRequest(body));
    if (!result.ok) throw new Error(`expected a verified event, got ${result.reason}`);
    return result.event;
  };

  it("maps email.received to message_received with the envelope", () => {
    expect(verifiedEvent(webhookBody("webhooks/email.received.json"))).toEqual({
      kind: "message_received",
      providerEventId: EVENT_ID,
      providerObjectId: "56761188-7520-42d8-8898-ff6fc54ce618",
      occurredAt: new Date("2026-02-22T23:41:12.126Z"),
      envelope: {
        from: "onboarding@resend.dev",
        to: ["delivered@resend.dev"],
        cc: [],
        receivedFor: ["forwarded@example.com"],
        subject: "Sending this example",
        rfcMessageId: "<111-222-333@email.example.com>",
      },
    });
  });

  it("treats a null received_for, as the list payload carries it, as empty", () => {
    const event = verifiedEvent(
      webhookBody("webhooks/email.received.json", (payload) => {
        dataOf(payload).received_for = null;
      }),
    );

    expect(event).toMatchObject({ kind: "message_received", envelope: { receivedFor: [] } });
  });

  it("maps email.bounced to a bounced status without the provider's bounce message", () => {
    const event = verifiedEvent(webhookBody("webhooks/email.bounced.json"));

    expect(event).toEqual({
      kind: "delivery_status",
      providerEventId: EVENT_ID,
      providerObjectId: "56761188-7520-42d8-8898-ff6fc54ce618",
      occurredAt: new Date("2026-11-22T23:41:12.126Z"),
      status: { type: "bounced", bounce: { type: "Permanent", subType: "Suppressed", statusCode: null } },
    });
    expect(JSON.stringify(event)).not.toContain("suppression list");
  });

  it("keeps only the enhanced status code from a bounce message that names the recipient", () => {
    const event = verifiedEvent(
      webhookBody("webhooks/email.bounced.json", (payload) => {
        (dataOf(payload).bounce as Record<string, unknown>).message =
          "smtp; 550 5.1.1 <alice@customer.test>: Recipient address rejected";
      }),
    );

    expect(event).toMatchObject({ status: { bounce: { statusCode: "5.1.1" } } });
    expect(JSON.stringify(event)).not.toContain("alice@customer.test");
  });

  it("maps email.suppressed to a suppressed status carrying only the suppression type", () => {
    const event = verifiedEvent(webhookBody("webhooks/email.suppressed.json"));

    expect(event).toMatchObject({
      kind: "delivery_status",
      status: { type: "suppressed", bounce: { type: "OnAccountSuppressionList", subType: null, statusCode: null } },
    });
    expect(JSON.stringify(event)).not.toContain("suppression list");
  });

  it("maps email.failed to a failed status", () => {
    expect(verifiedEvent(webhookBody("webhooks/email.failed.json"))).toMatchObject({
      kind: "delivery_status",
      status: { type: "failed", bounce: null },
    });
  });

  it.each([
    ["email.sent", "sent"],
    ["email.delivered", "delivered"],
    ["email.delivery_delayed", "delivery_delayed"],
    ["email.complained", "complained"],
  ])("maps %s to the %s delivery status", (providerType, statusType) => {
    const body = webhookBody("webhooks/email.failed.json", (payload) => {
      payload.type = providerType;
      delete dataOf(payload).failed;
    });

    expect(verifiedEvent(body)).toMatchObject({
      kind: "delivery_status",
      providerObjectId: "56761188-7520-42d8-8898-ff6fc54ce618",
      status: { type: statusType, bounce: null },
    });
  });

  it.each(["domain.created", "domain.updated", "domain.deleted"])("maps %s to domain_status", (providerType) => {
    const body = Buffer.from(
      JSON.stringify({
        type: providerType,
        created_at: "2026-10-03T13:29:18.978Z",
        data: { id: "9c539a5d-e048-4fb5-8490-d2a02dbe2850" },
      }),
    );

    expect(verifiedEvent(body)).toEqual({
      kind: "domain_status",
      providerEventId: EVENT_ID,
      providerObjectId: "9c539a5d-e048-4fb5-8490-d2a02dbe2850",
      occurredAt: new Date("2026-10-03T13:29:18.978Z"),
    });
  });

  it.each(["email.opened", "email.clicked", "contact.created"])("records %s as unsupported", (providerType) => {
    const body = webhookBody("webhooks/email.failed.json", (payload) => {
      payload.type = providerType;
    });

    expect(verifiedEvent(body)).toEqual({
      kind: "unsupported",
      providerEventId: EVENT_ID,
      occurredAt: new Date("2026-11-22T23:41:12.126Z"),
      providerType,
    });
  });
});

describe("Resend inbound receiver: content fetch", () => {
  it("reads the received email, then downloads the raw MIME without the API key", async () => {
    const provider = happyPath();

    await receiverFor(provider.fetch).fetchMessage(EMAIL_ID);

    expect(provider.calls.map(({ method, url, authorization }) => ({ method, url, authorization }))).toEqual([
      {
        method: "GET",
        url: `https://api.resend.com/emails/receiving/${EMAIL_ID}`,
        authorization: `Bearer ${API_KEY}`,
      },
      { method: "GET", url: DOWNLOAD_URL, authorization: null },
    ]);
    expect(provider.calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
  });

  it("encodes the provider id into the request path", async () => {
    const provider = happyPath();

    await receiverFor(provider.fetch).fetchMessage("a/../b?c");

    expect(provider.calls[0]?.url).toBe("https://api.resend.com/emails/receiving/a%2F..%2Fb%3Fc");
  });

  it("normalizes the downloaded MIME, not the provider's parsed fields", async () => {
    const message = await receiverFor(happyPath().fetch).fetchMessage(EMAIL_ID);

    expect(message.raw.equals(recordedRaw())).toBe(true);
    expect(message.rfcMessageId).toBe(
      "<010201a101f751fd-922fcadb-c495-4e2e-87a7-d9cc8946271f-000000@eu-west-1.amazonses.com>",
    );
    expect(message.inReplyTo).toBe("<parent-1@example.com>");
    expect(message.references).toEqual(["<root-0@example.com>", "<parent-1@example.com>"]);
    expect(message.from).toEqual({ address: "s0-probe@radioso.ai", displayName: "S0 probe" });
    expect(message.automation.autoSubmitted).toBe("auto-generated");
    expect(message.text).toContain("probe body");
  });

  it("adds received_for to the delivered-to set", async () => {
    const record = receivedRecord((value) => {
      value.received_for = ["relay-token@in.relay.test"];
    });

    const message = await receiverFor(happyPath(record).fetch).fetchMessage(EMAIL_ID);

    expect(message.deliveredTo).toContain("relay-token@in.relay.test");
  });

  it.todo(
    "keeps the relay address in deliveredTo for a Google Workspace forward (fixture resend/api/get-received-email.forwarded-google-workspace.json)",
  );
  it.todo(
    "keeps the relay address in deliveredTo for a Microsoft 365 forward (fixture resend/api/get-received-email.forwarded-microsoft-365.json)",
  );
});

describe("Resend inbound receiver: authentication and spam verdicts", () => {
  it("maps the recorded authentication results", async () => {
    const message = await receiverFor(happyPath().fetch).fetchMessage(EMAIL_ID);

    expect(message.authentication).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
  });

  it("keeps each provider verdict and reads anything else as unknown", async () => {
    const record = receivedRecord((value) => {
      value.authentication = { spf: "fail", dkim: "processing_failed", dmarc: "softfail" };
    });

    const message = await receiverFor(happyPath(record).fetch).fetchMessage(EMAIL_ID);

    expect(message.authentication).toEqual({ spf: "fail", dkim: "processing_failed", dmarc: "unknown" });
  });

  it("reads a missing authentication block as unknown", async () => {
    const record = receivedRecord((value) => {
      delete value.authentication;
    });

    const message = await receiverFor(happyPath(record).fetch).fetchMessage(EMAIL_ID);

    expect(message.authentication).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
  });

  it.each([
    ["PASS", "not_spam"],
    ["FAIL", "spam"],
    ["fail", "spam"],
    ["GRAY", "unknown"],
    ["PROCESSING_FAILED", "unknown"],
    [undefined, "unknown"],
  ])("maps x-ses-spam-verdict %s to %s", async (verdict, expected) => {
    const record = receivedRecord((value) => {
      const headers = value.headers as Record<string, unknown>;
      if (verdict === undefined) delete headers["x-ses-spam-verdict"];
      else headers["x-ses-spam-verdict"] = verdict;
    });

    const message = await receiverFor(happyPath(record).fetch).fetchMessage(EMAIL_ID);

    expect(message.spamVerdict).toBe(expected);
  });
});

describe("Resend inbound receiver: fetch failures", () => {
  const failingWith = (response: () => Response) =>
    receiverFor(fakeResend((url) => (url === DOWNLOAD_URL ? new Response(new Uint8Array(recordedRaw())) : response())).fetch);

  it.each([
    [401, "invalid_api_key", false, "provider_auth_failed"],
    [403, "restricted_api_key", false, "provider_auth_failed"],
    [404, "not_found", false, "message_not_found"],
    [422, "validation_error", false, "provider_rejected"],
    [429, "rate_limit_exceeded", true, "provider_rate_limited"],
    [500, "internal_server_error", true, "provider_unavailable"],
    [503, undefined, true, "provider_unavailable"],
  ])("classifies a %s %s response", async (status, name, retryable, code) => {
    const receiver = failingWith(() => json(name ? { statusCode: status, name, message: "detail" } : {}, status));

    const failure = await fetchFailure(receiver);

    expect(failure).toBeInstanceOf(InboundFetchError);
    expect(failure).toMatchObject({ retryable, code });
  });

  it("retries a network failure", async () => {
    const receiver = receiverFor(
      fakeResend(() => {
        throw new TypeError("fetch failed");
      }).fetch,
    );

    expect(await fetchFailure(receiver)).toMatchObject({ retryable: true, code: "provider_unreachable" });
  });

  it("times out a hung request and retries it", async () => {
    const hanging: ResendFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const reason: unknown = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        });
      });

    const failure = await fetchFailure(receiverFor(hanging, 5));

    expect(failure).toMatchObject({ retryable: true, code: "provider_timeout" });
  });

  it("retries a response that is not JSON", async () => {
    const receiver = failingWith(() => new Response("<html>gateway</html>", { status: 200 }));

    expect(await fetchFailure(receiver)).toMatchObject({ retryable: true, code: "malformed_provider_response" });
  });

  it("retries a record that has no raw download yet", async () => {
    const record = receivedRecord((value) => {
      delete value.raw;
    });

    expect(await fetchFailure(receiverFor(happyPath(record).fetch))).toMatchObject({
      retryable: true,
      code: "raw_unavailable",
    });
  });

  it("refuses a raw download URL that is not https", async () => {
    const record = receivedRecord((value) => {
      value.raw = { download_url: "http://cdn.resend.app/receiving/raw/x", expires_at: "2026-10-03T14:32:48.358Z" };
    });

    expect(await fetchFailure(receiverFor(happyPath(record).fetch))).toMatchObject({
      retryable: true,
      code: "raw_unavailable",
    });
  });

  it("retries an expired raw download, since every attempt re-reads a fresh URL", async () => {
    const receiver = receiverFor(
      fakeResend((url) => (url === DOWNLOAD_URL ? new Response("expired", { status: 403 }) : json(receivedRecord())))
        .fetch,
    );

    expect(await fetchFailure(receiver)).toMatchObject({ retryable: true, code: "raw_download_failed" });
  });

  it("never carries the API key, provider message or content in the error", async () => {
    const receiver = failingWith(() =>
      json({ statusCode: 422, name: "validation_error", message: "alice@customer.test: Subject secret" }, 422),
    );

    const failure = await fetchFailure(receiver);
    const rendered = `${String(failure)} ${JSON.stringify(failure)} ${(failure as Error).stack ?? ""}`;

    expect(rendered).not.toContain(API_KEY);
    expect(rendered).not.toContain("alice@customer.test");
    expect(rendered).not.toContain("Subject secret");
  });
});
