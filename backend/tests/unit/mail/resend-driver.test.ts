import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ResendApiClient, type ResendFetch } from "../../../src/modules/mail/adapters/resendApi.js";
import {
  ResendEmailDeliveryError,
  ResendEmailDriver,
} from "../../../src/modules/mail/adapters/resendDriver.js";
import {
  EmailLookupError,
  EmailSendError,
  rfcMessageId,
  type EmailMessage,
} from "../../../src/modules/mail/public.js";

const RESEND_API_FIXTURES = fileURLToPath(
  new URL("../../fixtures/email-channel/resend/api/", import.meta.url),
);
const API_KEY = "re_test_SECRETKEY_0123456789";

const fixtureJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${RESEND_API_FIXTURES}${name}`, "utf8")) as Record<string, unknown>;

const sendResponse = fixtureJson("send-email.response.json");
const PROVIDER_MESSAGE_ID = sendResponse.id as string;
const deliveredEmail = fixtureJson("get-sent-email.delivered.json");

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const driverAnswering = (answer: (call: RecordedCall) => Response | Promise<Response>) => {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn<ResendFetch>(async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return answer(call);
  });
  const driver = new ResendEmailDriver({ api: new ResendApiClient({ apiKey: API_KEY, fetch }) });
  return { driver, calls, fetch };
};

const failingWith = (failure: unknown) => {
  const fetch = vi.fn<ResendFetch>(async () => {
    throw failure;
  });
  return new ResendEmailDriver({ api: new ResendApiClient({ apiKey: API_KEY, fetch }) });
};

const channelReply = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: "ada@example.com",
  from: { email: "support@acme.test", name: "Acme Support" },
  replyTo: "support+t_9f3c2a@acme.test",
  subject: "Re: Order 1042",
  text: "Your order shipped.",
  html: "<p>Your order shipped.</p>",
  kind: "channel_reply",
  idempotencyKey: "email:send:msg:5b0e1f9e-4c4e-4b8e-9d8a-0f3f7f1f2a10",
  threading: {
    messageId: rfcMessageId("<5b0e1f9e.k3x9@acme.test>"),
    inReplyTo: rfcMessageId("<CAH4p=q@mail.gmail.com>"),
    references: [rfcMessageId("<first@mail.gmail.com>"), rfcMessageId("<CAH4p=q@mail.gmail.com>")],
    autoSubmitted: "auto-generated",
  },
  ...overrides,
});

const sendFailure = async (driver: ResendEmailDriver, message: EmailMessage = channelReply()) => {
  try {
    await driver.send(message);
  } catch (error) {
    return error;
  }
  throw new Error("expected the send to fail");
};

const lookupFailure = async (driver: ResendEmailDriver) => {
  try {
    await driver.lookup(PROVIDER_MESSAGE_ID);
  } catch (error) {
    return error;
  }
  throw new Error("expected the lookup to fail");
};

describe("ResendEmailDriver.send", () => {
  it("posts the message with its threading headers and reports the provider id", async () => {
    const { driver, calls } = driverAnswering(() => json(200, sendResponse));

    const result = await driver.send(channelReply());

    expect(result).toEqual({
      dispatched: true,
      providerMessageId: PROVIDER_MESSAGE_ID,
      deliveredMessageId: null,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.method).toBe("POST");
    expect(call?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(call?.body).toEqual({
      from: "Acme Support <support@acme.test>",
      to: "ada@example.com",
      reply_to: "support+t_9f3c2a@acme.test",
      subject: "Re: Order 1042",
      text: "Your order shipped.",
      html: "<p>Your order shipped.</p>",
      tags: [{ name: "kind", value: "channel_reply" }],
      headers: {
        "Message-ID": "<5b0e1f9e.k3x9@acme.test>",
        "In-Reply-To": "<CAH4p=q@mail.gmail.com>",
        References: "<first@mail.gmail.com> <CAH4p=q@mail.gmail.com>",
        "Auto-Submitted": "auto-generated",
      },
    });
  });

  it("omits the threading headers a message does not carry", async () => {
    const { driver, calls } = driverAnswering(() => json(200, sendResponse));

    await driver.send(channelReply({
      threading: {
        messageId: rfcMessageId("<first-reply@acme.test>"),
        inReplyTo: null,
        references: [],
        autoSubmitted: null,
      },
    }));

    expect(calls[0]?.body?.headers).toEqual({ "Message-ID": "<first-reply@acme.test>" });
  });

  it("sends no custom headers, reply-to or display name when the message has none", async () => {
    const { driver, calls } = driverAnswering(() => json(200, sendResponse));

    await driver.send(channelReply({
      from: { email: "support@acme.test", name: null },
      replyTo: null,
      threading: null,
      html: undefined,
    }));

    expect(calls[0]?.body).not.toHaveProperty("headers");
    expect(calls[0]?.body).not.toHaveProperty("reply_to");
    expect(calls[0]?.body?.from).toBe("support@acme.test");
  });

  it("forwards the idempotency key so a replay returns the original send", async () => {
    const { driver, calls } = driverAnswering(() => json(200, sendResponse));

    const first = await driver.send(channelReply());
    const replay = await driver.send(channelReply());

    expect(calls.map((call) => call.headers["Idempotency-Key"])).toEqual([
      "email:send:msg:5b0e1f9e-4c4e-4b8e-9d8a-0f3f7f1f2a10",
      "email:send:msg:5b0e1f9e-4c4e-4b8e-9d8a-0f3f7f1f2a10",
    ]);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(replay.providerMessageId).toBe(first.providerMessageId);
  });

  it("sends no idempotency header when the message has no key", async () => {
    const { driver, calls } = driverAnswering(() => json(200, sendResponse));

    await driver.send(channelReply({ idempotencyKey: null }));

    expect(calls[0]?.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("reports an accepted message with an unknown provider id when the reply cannot be read", async () => {
    const { driver } = driverAnswering(() => new Response("", { status: 200 }));

    expect(await driver.send(channelReply())).toEqual({
      dispatched: true,
      providerMessageId: null,
      deliveredMessageId: null,
    });
  });

  it("classifies a changed body under a used key as a rejected body mismatch", async () => {
    const { driver } = driverAnswering(() =>
      json(409, fixtureJson("send-email.idempotency-conflict.json")),
    );

    const error = await sendFailure(driver);

    expect(error).toBeInstanceOf(EmailSendError);
    expect(error).toBeInstanceOf(ResendEmailDeliveryError);
    expect(error).toMatchObject({
      outcome: "rejected",
      code: "idempotency_body_mismatch",
      statusCode: 409,
      providerErrorName: "invalid_idempotent_request",
    });
    expect(String((error as Error).message)).not.toContain("request body");
  });

  it("classifies a concurrent request under the same key as retryable", async () => {
    const { driver } = driverAnswering(() =>
      json(409, {
        statusCode: 409,
        name: "concurrent_idempotent_requests",
        message: "Same idempotency key used while original request is still in progress.",
      }),
    );

    expect(await sendFailure(driver)).toMatchObject({
      outcome: "retryable",
      code: "idempotency_in_flight",
      statusCode: 409,
    });
  });

  describe("a 409 it cannot classify", () => {
    const unreadableBody = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"statusCode":409,"na'));
          controller.error(new Error("socket hang up"));
        },
      });

    it.each([
      ["a truncated JSON body", () => new Response('{"statusCode":409,"name":"concurrent_idem', { status: 409 })],
      ["a body stream that fails", () => new Response(unreadableBody(), { status: 409 })],
      ["an unrecognized error name", () => json(409, { statusCode: 409, name: "idempotency_key_locked", message: "?" })],
      ["no error name", () => json(409, { statusCode: 409, message: "Conflict" })],
    ])("treats %s as an unknown outcome, not a rejection", async (_case, answer) => {
      const { driver } = driverAnswering(answer);

      const error = await sendFailure(driver);

      expect(error).toBeInstanceOf(EmailSendError);
      expect(error).toMatchObject({ outcome: "unknown", code: "unrecognized_conflict", statusCode: 409 });
    });

    it("keeps an earlier unknown send reconcilable under the same key", async () => {
      const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      const answers: (() => Response)[] = [
        () => {
          throw timeout;
        },
        () => new Response('{"statusCode":409,"name":"concurrent_idem', { status: 409 }),
        () => json(200, sendResponse),
      ];
      const { driver, calls } = driverAnswering(() => answers[calls.length - 1]());

      expect(await sendFailure(driver)).toMatchObject({ outcome: "unknown", code: "timeout" });
      expect(await sendFailure(driver)).toMatchObject({ outcome: "unknown", code: "unrecognized_conflict" });
      expect(await driver.send(channelReply())).toEqual({
        dispatched: true,
        providerMessageId: PROVIDER_MESSAGE_ID,
        deliveredMessageId: null,
      });
      expect(new Set(calls.map((call) => call.headers["Idempotency-Key"]))).toEqual(
        new Set([channelReply().idempotencyKey]),
      );
    });
  });

  it("classifies a rate limit as retryable", async () => {
    const { driver } = driverAnswering(() =>
      json(429, { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." }),
    );

    expect(await sendFailure(driver)).toMatchObject({ outcome: "retryable", code: "rate_limited" });
  });

  it.each([500, 502, 503])("classifies a %i as an unknown outcome", async (status) => {
    const { driver } = driverAnswering(() =>
      json(status, { statusCode: status, name: "internal_server_error", message: "boom" }),
    );

    expect(await sendFailure(driver)).toMatchObject({
      outcome: "unknown",
      code: "unavailable",
      statusCode: status,
    });
  });

  it("classifies a timeout as an unknown outcome", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";

    const error = await sendFailure(failingWith(timeout));

    expect(error).toBeInstanceOf(EmailSendError);
    expect(error).toMatchObject({ outcome: "unknown", code: "timeout", statusCode: null });
  });

  it("classifies a lost connection as an unknown outcome", async () => {
    expect(await sendFailure(failingWith(new TypeError("fetch failed")))).toMatchObject({
      outcome: "unknown",
      code: "unreachable",
    });
  });

  it.each([
    [400, "validation_error", "rejected"],
    [403, "validation_error", "rejected"],
    [422, "validation_error", "rejected"],
    [401, "missing_api_key", "auth"],
  ])("classifies a %i %s as rejected", async (status, name, code) => {
    const { driver } = driverAnswering(() =>
      json(status, {
        statusCode: status,
        name,
        message: "The acme.test domain is not verified for ada@example.com",
      }),
    );

    const error = await sendFailure(driver);

    expect(error).toMatchObject({ outcome: "rejected", code, statusCode: status, providerErrorName: name });
    expect(String((error as Error).message)).not.toContain("acme.test");
    expect(String((error as Error).message)).not.toContain("ada@example.com");
  });

  it("rejects an injected display name before calling the provider", async () => {
    const { driver, fetch } = driverAnswering(() => json(200, sendResponse));

    const error = await sendFailure(
      driver,
      channelReply({ from: { email: "support@acme.test", name: "Acme\r\nBcc: x@evil.test" } }),
    );

    expect(error).toBeInstanceOf(EmailSendError);
    expect(error).toMatchObject({ outcome: "rejected", code: "invalid_header_value" });
    expect(String((error as Error).message)).not.toContain("evil.test");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("ResendEmailDriver.lookup", () => {
  it("reads the delivered Message-ID and last event of a sent email", async () => {
    const { driver, calls } = driverAnswering(() => json(200, deliveredEmail));

    const status = await driver.lookup(PROVIDER_MESSAGE_ID);

    expect(calls[0]).toMatchObject({
      url: `https://api.resend.com/emails/${PROVIDER_MESSAGE_ID}`,
      method: "GET",
      body: null,
    });
    expect(status).toEqual({
      providerMessageId: PROVIDER_MESSAGE_ID,
      deliveredMessageId: deliveredEmail.message_id,
      lastEvent: "delivered",
    });
  });

  it("reports no delivered Message-ID while the email is still queued", async () => {
    const { driver } = driverAnswering(() =>
      json(200, { ...deliveredEmail, last_event: "queued", message_id: null }),
    );

    expect(await driver.lookup(PROVIDER_MESSAGE_ID)).toEqual({
      providerMessageId: PROVIDER_MESSAGE_ID,
      deliveredMessageId: null,
      lastEvent: "queued",
    });
  });

  it.each([
    ["bounced", "bounced"],
    ["suppressed", "suppressed"],
    ["delivery_delayed", "delivery_delayed"],
    ["opened", "unknown"],
    ["something_new", "unknown"],
  ])("maps the provider event %s to %s", async (lastEvent, expected) => {
    const { driver } = driverAnswering(() => json(200, { ...deliveredEmail, last_event: lastEvent }));

    expect((await driver.lookup(PROVIDER_MESSAGE_ID))?.lastEvent).toBe(expected);
  });

  it("drops a delivered Message-ID it cannot use as a header value", async () => {
    const { driver } = driverAnswering(() =>
      json(200, { ...deliveredEmail, message_id: "not-a-message-id" }),
    );

    expect((await driver.lookup(PROVIDER_MESSAGE_ID))?.deliveredMessageId).toBeNull();
  });

  it("returns null when the provider has no such email", async () => {
    const { driver } = driverAnswering(() =>
      json(404, { statusCode: 404, name: "not_found", message: "Email not found" }),
    );

    expect(await driver.lookup(PROVIDER_MESSAGE_ID)).toBeNull();
  });

  it("raises a retryable lookup error on a provider outage or timeout", async () => {
    const { driver } = driverAnswering(() =>
      json(503, { statusCode: 503, name: "internal_server_error", message: "down" }),
    );
    const timeout = new Error("timeout");
    timeout.name = "TimeoutError";

    expect(await lookupFailure(driver)).toMatchObject({ retryable: true, code: "unavailable" });
    const timedOut = await lookupFailure(failingWith(timeout));
    expect(timedOut).toBeInstanceOf(EmailLookupError);
    expect(timedOut).toMatchObject({ retryable: true, code: "timeout" });
  });

  it("raises a non-retryable lookup error when the provider refuses the credentials", async () => {
    const { driver } = driverAnswering(() =>
      json(401, { statusCode: 401, name: "invalid_api_key", message: "API key is invalid" }),
    );

    expect(await lookupFailure(driver)).toMatchObject({ retryable: false, code: "auth" });
  });

  it("raises a retryable lookup error on an unexpected reply shape", async () => {
    const { driver } = driverAnswering(() => json(200, ["not", "an", "email"]));

    expect(await lookupFailure(driver)).toMatchObject({
      retryable: true,
      code: "malformed_response",
    });
  });
});
