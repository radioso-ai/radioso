import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { type LettermintFetch } from "../../../src/modules/mail/adapters/lettermintApi.js";
import {
  EmailLookupError,
  EmailSendError,
  LettermintApiClient,
  LettermintEmailDeliveryError,
  LettermintEmailDriver,
  rfcMessageId,
  type EmailMessage,
} from "../../../src/modules/mail/public.js";

const API_FIXTURES = fileURLToPath(new URL("../../fixtures/email-channel/lettermint/api/", import.meta.url));
const PROJECT_TOKEN = "lm_project_SECRET_0123456789";
const TEAM_TOKEN = "lm_team_SECRET_9876543210";

const fixtureJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${API_FIXTURES}${name}`, "utf8")) as Record<string, unknown>;

const sendResponse = fixtureJson("send-mail.response.json");
const PROVIDER_MESSAGE_ID = sendResponse.message_id as string;
const deliveredMessage = fixtureJson("get-message.outbound-delivered.json");

interface RecordedCall {
  url: string;
  method: string;
  redirect: RequestRedirect | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const driverAnswering = (
  answer: (call: RecordedCall) => Response | Promise<Response>,
  tokens: { projectToken?: string; teamToken?: string } = { projectToken: PROJECT_TOKEN, teamToken: TEAM_TOKEN },
) => {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn<LettermintFetch>(async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      redirect: init.redirect,
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return answer(call);
  });
  const driver = new LettermintEmailDriver({ api: new LettermintApiClient({ ...tokens, fetch }) });
  return { driver, calls, fetch };
};

const failingWith = (failure: unknown) => {
  const fetch = vi.fn<LettermintFetch>(async () => {
    throw failure;
  });
  return new LettermintEmailDriver({
    api: new LettermintApiClient({ projectToken: PROJECT_TOKEN, teamToken: TEAM_TOKEN, fetch }),
  });
};

const channelReply = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: "ada@example.test",
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

const sendFailure = async (driver: LettermintEmailDriver, message: EmailMessage = channelReply()) => {
  try {
    await driver.send(message);
  } catch (error) {
    return error;
  }
  throw new Error("expected the send to fail");
};

const lookupFailure = async (driver: LettermintEmailDriver) => {
  try {
    await driver.lookup(PROVIDER_MESSAGE_ID);
  } catch (error) {
    return error;
  }
  throw new Error("expected the lookup to fail");
};

describe("LettermintApiClient", () => {
  it("needs at least one token", () => {
    expect(() => new LettermintApiClient({})).toThrow("A Lettermint project or team token is required");
    expect(() => new LettermintApiClient({ projectToken: "  ", teamToken: "" })).toThrow(
      "A Lettermint project or team token is required",
    );
  });
});

describe("LettermintEmailDriver.send", () => {
  it("posts the message with the project token and reports both ids", async () => {
    const { driver, calls } = driverAnswering(() => json(202, sendResponse));

    const result = await driver.send(channelReply());

    expect(result).toEqual({
      dispatched: true,
      driver: "lettermint",
      providerMessageId: PROVIDER_MESSAGE_ID,
      deliveredMessageId: "<5b0e1f9e.k3x9@acme.test>",
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.lettermint.co/v1/send");
    expect(call?.method).toBe("POST");
    expect(call?.redirect).toBe("manual");
    expect(call?.headers["x-lettermint-token"]).toBe(PROJECT_TOKEN);
    expect(call?.headers).not.toHaveProperty("Authorization");
    expect(call?.body).toEqual({
      from: "Acme Support <support@acme.test>",
      to: ["ada@example.test"],
      reply_to: ["support+t_9f3c2a@acme.test"],
      subject: "Re: Order 1042",
      text: "Your order shipped.",
      html: "<p>Your order shipped.</p>",
      tags: [{ name: "kind", value: "channel_reply" }],
      headers: {
        "Message-ID": "<5b0e1f9e.k3x9@acme.test>",
        "X-LM-Preserve-Message-ID": "true",
        "In-Reply-To": "<CAH4p=q@mail.gmail.com>",
        References: "<first@mail.gmail.com> <CAH4p=q@mail.gmail.com>",
        "Auto-Submitted": "auto-generated",
      },
    });
  });

  it("omits the threading headers a message does not carry", async () => {
    const { driver, calls } = driverAnswering(() => json(202, sendResponse));

    await driver.send(channelReply({
      threading: { messageId: rfcMessageId("<first-reply@acme.test>"), inReplyTo: null, references: [], autoSubmitted: null },
    }));

    expect(calls[0]?.body?.headers).toEqual({
      "Message-ID": "<first-reply@acme.test>",
      "X-LM-Preserve-Message-ID": "true",
    });
  });

  it("sends no custom headers, reply-to, tags or display name when the message has none", async () => {
    const { driver, calls } = driverAnswering(() => json(202, sendResponse));

    const result = await driver.send(channelReply({
      from: { email: "support@acme.test", name: null },
      replyTo: null,
      threading: null,
      kind: undefined,
      html: undefined,
    }));

    expect(calls[0]?.body).toEqual({
      from: "support@acme.test",
      to: ["ada@example.test"],
      subject: "Re: Order 1042",
      text: "Your order shipped.",
    });
    expect(result.deliveredMessageId).toBeNull();
  });

  it("asks for no Message-ID preservation when no Message-ID is sent", async () => {
    const { driver, calls } = driverAnswering(() => json(202, sendResponse));

    await driver.send(channelReply({ threading: null, listUnsubscribeUrl: "https://app.example.test/u/abc" }));

    expect(calls[0]?.body?.headers).toEqual({
      "List-Unsubscribe": "<https://app.example.test/u/abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("adds RFC 8058 one-click unsubscribe headers beside the threading headers", async () => {
    const { driver, calls } = driverAnswering(() => json(202, sendResponse));

    await driver.send(channelReply({ listUnsubscribeUrl: "https://app.example.test/u/abc" }));

    expect(calls[0]?.body?.headers).toMatchObject({
      "Message-ID": "<5b0e1f9e.k3x9@acme.test>",
      "X-LM-Preserve-Message-ID": "true",
      "List-Unsubscribe": "<https://app.example.test/u/abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it.each(["not a url", "mailto:unsubscribe@example.test"])("rejects the unsubscribe URL %j", async (url) => {
    const { driver, fetch } = driverAnswering(() => json(202, sendResponse));

    expect(await sendFailure(driver, channelReply({ listUnsubscribeUrl: url }))).toMatchObject({
      outcome: "rejected",
      code: "invalid_header_value",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards the idempotency key so a replay returns the original send", async () => {
    const { driver, calls } = driverAnswering(() => json(202, sendResponse));

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
    const { driver, calls } = driverAnswering(() => json(202, sendResponse));

    await driver.send(channelReply({ idempotencyKey: null }));

    expect(calls[0]?.headers).not.toHaveProperty("Idempotency-Key");
  });

  it.each([
    ["an empty body", () => new Response("", { status: 202 })],
    ["a body that is not JSON", () => new Response("<html>accepted</html>", { status: 202 })],
  ])("reports an accepted message with an unknown provider id on %s", async (_case, answer) => {
    const { driver } = driverAnswering(answer);

    expect(await driver.send(channelReply())).toEqual({
      dispatched: true,
      driver: "lettermint",
      providerMessageId: null,
      deliveredMessageId: "<5b0e1f9e.k3x9@acme.test>",
    });
  });

  it("classifies a changed body under a used key as a rejected body mismatch", async () => {
    const { driver } = driverAnswering(() =>
      json(409, { error: { code: "invalid_idempotent_request", message: "different payload for ada@example.test" } }),
    );

    const error = await sendFailure(driver);

    expect(error).toBeInstanceOf(LettermintEmailDeliveryError);
    expect(error).toMatchObject({
      outcome: "rejected",
      code: "idempotency_body_mismatch",
      statusCode: 409,
      providerErrorName: "invalid_idempotent_request",
    });
  });

  it("classifies a concurrent request under the same key as retryable", async () => {
    const { driver } = driverAnswering(() =>
      json(409, { error: { code: "concurrent_idempotent_requests", message: "in progress" } }),
    );

    expect(await sendFailure(driver)).toMatchObject({ outcome: "retryable", code: "idempotency_in_flight", statusCode: 409 });
  });

  describe("a 409 it cannot classify", () => {
    it.each([
      ["the documented mismatch body, which names no code", () => json(409, fixtureJson("send-mail.idempotency-mismatch.json"))],
      ["the documented in-flight body, which names no code", () => json(409, fixtureJson("send-mail.concurrent-idempotent-request.json"))],
      ["a truncated JSON body", () => new Response('{"error":{"code":"concurrent_idem', { status: 409 })],
      ["an unrecognized code", () => json(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "?" } })],
    ])("treats %s as an unknown outcome, not a rejection", async (_case, answer) => {
      const { driver } = driverAnswering(answer);

      const error = await sendFailure(driver);

      expect(error).toBeInstanceOf(EmailSendError);
      expect(error).toMatchObject({ outcome: "unknown", code: "unrecognized_conflict", statusCode: 409 });
    });
  });

  it("classifies a rate limit as retryable", async () => {
    const { driver } = driverAnswering(() => json(429, fixtureJson("error.rate-limited.json")));

    expect(await sendFailure(driver)).toMatchObject({
      outcome: "retryable",
      code: "rate_limited",
      providerErrorName: "RATE_LIMIT_EXCEEDED",
    });
  });

  it.each([500, 502, 503])("classifies a %i as an unknown outcome", async (status) => {
    const { driver } = driverAnswering(() => json(status, { error: { code: "SERVER_ERROR", message: "boom" } }));

    expect(await sendFailure(driver)).toMatchObject({ outcome: "unknown", code: "unavailable", statusCode: status });
  });

  it("follows no redirect and treats one as an unknown outcome", async () => {
    const { driver } = driverAnswering(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }));

    expect(await sendFailure(driver)).toMatchObject({ outcome: "unknown", code: "malformed_response", statusCode: 302 });
  });

  it("classifies a timeout as an unknown outcome", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

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
    [401, { message: "Unauthenticated." }, "auth", null],
    [403, fixtureJson("error.forbidden.json"), "auth", "FORBIDDEN"],
    [403, { error: { code: "FEATURE_NOT_AVAILABLE", message: "not on ada@example.test's plan" } }, "rejected", "FEATURE_NOT_AVAILABLE"],
    [422, { message: "The from domain acme.test is not verified.", errors: { from: ["acme.test is not verified"] } }, "rejected", null],
    // Captured live 2026-10-24: an unverified team sending outside its members and test addresses.
    [422, { error: { code: "VALIDATION_ERROR", message: "Recipient 'ada@example.test' is not a verified team member." } }, "rejected", "VALIDATION_ERROR"],
  ])("classifies a %i as rejected (%s)", async (status, body, code, providerErrorName) => {
    const { driver } = driverAnswering(() => json(status, body));

    const error = await sendFailure(driver);

    expect(error).toMatchObject({ outcome: "rejected", code, statusCode: status, providerErrorName });
    const rendered = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
    expect(rendered).not.toContain("acme.test");
    expect(rendered).not.toContain("ada@example.test");
    expect(rendered).not.toContain(PROJECT_TOKEN);
  });

  it("refuses to send without a project token", async () => {
    const { driver, fetch } = driverAnswering(() => json(202, sendResponse), { teamToken: TEAM_TOKEN });

    expect(await sendFailure(driver)).toMatchObject({ outcome: "rejected", code: "auth", statusCode: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an injected display name before calling the provider", async () => {
    const { driver, fetch } = driverAnswering(() => json(202, sendResponse));

    const error = await sendFailure(
      driver,
      channelReply({ from: { email: "support@acme.test", name: "Acme\r\nBcc: x@evil.test" } }),
    );

    expect(error).toMatchObject({ outcome: "rejected", code: "invalid_header_value" });
    expect(String((error as Error).message)).not.toContain("evil.test");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("LettermintEmailDriver.lookup", () => {
  it("reads the message with the team token and reports its status", async () => {
    const { driver, calls } = driverAnswering(() => json(200, deliveredMessage));

    const status = await driver.lookup(PROVIDER_MESSAGE_ID);

    expect(calls[0]).toMatchObject({
      url: `https://api.lettermint.co/v1/messages/${PROVIDER_MESSAGE_ID}`,
      method: "GET",
      body: null,
    });
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TEAM_TOKEN}`);
    expect(calls[0]?.headers).not.toHaveProperty("x-lettermint-token");
    expect(status).toEqual({ providerMessageId: PROVIDER_MESSAGE_ID, deliveredMessageId: null, lastEvent: "delivered" });
  });

  it.each([
    ["pending", "queued"],
    ["queued", "queued"],
    ["scheduled", "queued"],
    ["processed", "sent"],
    ["delivered", "delivered"],
    ["opened", "delivered"],
    ["clicked", "delivered"],
    ["unsubscribed", "delivered"],
    ["soft_bounced", "delivery_delayed"],
    ["hard_bounced", "bounced"],
    ["spam_complaint", "complained"],
    ["failed", "failed"],
    ["blocked", "failed"],
    ["policy_rejected", "failed"],
    ["canceled", "failed"],
    ["suppressed", "suppressed"],
    ["quarantined", "unknown"],
    ["something_new", "unknown"],
    [42, "unknown"],
  ])("maps the provider status %s to %s", async (providerStatus, expected) => {
    const { driver } = driverAnswering(() => json(200, { ...deliveredMessage, status: providerStatus }));

    expect((await driver.lookup(PROVIDER_MESSAGE_ID))?.lastEvent).toBe(expected);
  });

  it("encodes the provider id into the request path", async () => {
    const { driver, calls } = driverAnswering(() => json(200, deliveredMessage));

    await driver.lookup("a/../b?c");

    expect(calls[0]?.url).toBe("https://api.lettermint.co/v1/messages/a%2F..%2Fb%3Fc");
  });

  it("returns null without a provider id", async () => {
    const { driver, fetch } = driverAnswering(() => json(200, deliveredMessage));

    expect(await driver.lookup("")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null when the provider has no such message", async () => {
    const { driver } = driverAnswering(() => json(404, { message: "No query results for model [Message]." }));

    expect(await driver.lookup(PROVIDER_MESSAGE_ID)).toBeNull();
  });

  it("raises a retryable lookup error on a provider outage or timeout", async () => {
    const { driver } = driverAnswering(() => json(503, { error: { code: "SERVER_ERROR", message: "down" } }));
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });

    expect(await lookupFailure(driver)).toMatchObject({ retryable: true, code: "unavailable" });
    const timedOut = await lookupFailure(failingWith(timeout));
    expect(timedOut).toBeInstanceOf(EmailLookupError);
    expect(timedOut).toMatchObject({ retryable: true, code: "timeout" });
  });

  it("raises a non-retryable lookup error when the provider refuses the credentials", async () => {
    const { driver } = driverAnswering(() => json(403, fixtureJson("error.forbidden.json")));

    expect(await lookupFailure(driver)).toMatchObject({ retryable: false, code: "auth" });
  });

  it("raises a non-retryable auth error, without calling the provider, on a send-only driver", async () => {
    const { driver, fetch } = driverAnswering(() => json(200, deliveredMessage), { projectToken: PROJECT_TOKEN });

    const error = await lookupFailure(driver);

    expect(error).toBeInstanceOf(EmailLookupError);
    expect(error).toMatchObject({ retryable: false, code: "auth" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("raises a retryable lookup error on an unexpected reply shape", async () => {
    const { driver } = driverAnswering(() => json(200, ["not", "a", "message"]));

    expect(await lookupFailure(driver)).toMatchObject({ retryable: true, code: "malformed_response" });
  });
});
