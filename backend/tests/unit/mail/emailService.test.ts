import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ResendApiClient } from "../../../src/modules/mail/adapters/resendApi.js";
import {
  EmailSendError,
  EmailService,
  LettermintEmailDriver,
  ResendEmailDeliveryError,
  ResendEmailDriver,
  createMailService,
  deliveryWebhookVerifierFor,
  rfcMessageId,
  type DeliveryWebhookVerifier,
  type EmailDriver,
  type EmailMessage,
  type EmailSendResult,
  type MailWebhookEnv,
  type SentEmailStatus,
} from "../../../src/modules/mail/public.js";

class RecordingEmailDriver implements EmailDriver {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.messages.push(message);
    return { dispatched: true, providerMessageId: "provider-1", deliveredMessageId: null };
  }

  async lookup(): Promise<SentEmailStatus | null> {
    return null;
  }
}

const PROVIDER_ACCEPTED_BODY = JSON.stringify({ id: "01a101f5-b214-78b7-9004-18f685cb0238" });

/** A Resend driver over the global `fetch`, which each test stubs. */
const resendDriver = (): ResendEmailDriver =>
  new ResendEmailDriver({ api: new ResendApiClient({ apiKey: "re_test" }) });

/** Reads a configured service's driver, which `createMailService` keeps private. */
const driverOf = (service: EmailService): EmailDriver => Reflect.get(service, "driver") as EmailDriver;

const CHANNEL_REPLY_SECRETS = {
  to: "ada@example.com",
  fromEmail: "support@acme.test",
  fromName: "Acme Support",
  replyTo: "support+t_9f3c2a7b@acme.test",
  subject: "Re: Order 1042 refund",
  text: "Your refund for order 1042 was issued.",
  html: "<p>Your refund for order 1042 was issued.</p>",
  idempotencyKey: "email:send:msg:5b0e1f9e-4c4e-4b8e-9d8a-0f3f7f1f2a10",
  messageId: "<5b0e1f9e.k3x9@acme.test>",
  inReplyTo: "<CAH4p=q@mail.gmail.com>",
};

const channelReply = (): EmailMessage => ({
  to: CHANNEL_REPLY_SECRETS.to,
  from: { email: CHANNEL_REPLY_SECRETS.fromEmail, name: CHANNEL_REPLY_SECRETS.fromName },
  replyTo: CHANNEL_REPLY_SECRETS.replyTo,
  subject: CHANNEL_REPLY_SECRETS.subject,
  text: CHANNEL_REPLY_SECRETS.text,
  html: CHANNEL_REPLY_SECRETS.html,
  kind: "channel_reply",
  metadata: { conversationId: "conv_1" },
  idempotencyKey: CHANNEL_REPLY_SECRETS.idempotencyKey,
  threading: {
    messageId: rfcMessageId(CHANNEL_REPLY_SECRETS.messageId),
    inReplyTo: rfcMessageId(CHANNEL_REPLY_SECRETS.inReplyTo),
    references: [rfcMessageId(CHANNEL_REPLY_SECRETS.inReplyTo)],
    autoSubmitted: "auto-generated",
  },
});

const consoleSpies = () =>
  (["info", "log", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );

const everythingLogged = (spies: ReturnType<typeof consoleSpies>): string =>
  JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

describe("mail service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies default sender details when sending mail", async () => {
    const driver = new RecordingEmailDriver();
    const service = new EmailService(driver, {
      fromEmail: "noreply@example.com",
      fromName: "Radioso",
    });

    await service.send({
      to: "ada@example.com",
      subject: "Welcome",
      text: "Hello",
    });

    expect(driver.messages[0]).toMatchObject({
      to: "ada@example.com",
      from: { email: "noreply@example.com", name: "Radioso" },
      subject: "Welcome",
      text: "Hello",
    });
  });

  it("forwards replyTo to the driver when provided", async () => {
    const driver = new RecordingEmailDriver();
    const service = new EmailService(driver, { fromEmail: "noreply@example.com" });

    await service.send({
      to: "ada@example.com",
      replyTo: "visitor@example.com",
      subject: "Contact request",
      text: "Hello",
    });

    expect(driver.messages[0]?.replyTo).toBe("visitor@example.com");
  });

  it("respects an explicit per-message from override", async () => {
    const driver = new RecordingEmailDriver();
    const service = new EmailService(driver, { fromEmail: "default@example.com" });

    await service.send({
      to: "ada@example.com",
      from: { email: "override@example.com", name: "Override" },
      subject: "Hi",
      text: "Hello",
    });

    expect(driver.messages[0]?.from).toEqual({ email: "override@example.com", name: "Override" });
  });

  it("reports a dispatched message and its provider id when the provider accepts it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PROVIDER_ACCEPTED_BODY, { status: 200 })));
    const service = createMailService({ MAIL_DRIVER: "resend", RESEND_MAIL_API_KEY: "re_test" });

    const result = await service.send({ to: "ada@example.com", subject: "Hi", text: "Hello" });

    expect(result).toEqual({
      dispatched: true,
      driver: "resend",
      providerMessageId: "01a101f5-b214-78b7-9004-18f685cb0238",
      deliveredMessageId: null,
    });
  });

  it("reports an undispatched message when the log driver only records it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = createMailService({ MAIL_DRIVER: "log" });

    const result = await service.send({ to: "ada@example.com", subject: "Hi", text: "Hello" });

    expect(result).toEqual({ dispatched: false, driver: "log", providerMessageId: null, deliveredMessageId: null });
  });

  it("reports an undispatched message when the noop driver discards it", async () => {
    const service = createMailService({ MAIL_DRIVER: "noop" });

    const result = await service.send({ to: "ada@example.com", subject: "Hi", text: "Hello" });

    expect(result).toEqual({ dispatched: false, driver: "noop", providerMessageId: null, deliveredMessageId: null });
  });

  it("selects the log driver when no provider key is configured", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = createMailService({});

    expect(await service.send({ to: "ada@example.com", subject: "Hi", text: "Hello" }))
      .toEqual({ dispatched: false, driver: "log", providerMessageId: null, deliveredMessageId: null });
  });

  it("builds a Resend-backed service from environment configuration", () => {
    const service = createMailService({
      MAIL_DRIVER: "resend",
      MAIL_FROM_EMAIL: "support@example.com",
      RESEND_MAIL_API_KEY: "re_test",
    });

    expect(service).toBeInstanceOf(EmailService);
    expect(Reflect.get(service, "driver")).toBeInstanceOf(ResendEmailDriver);
  });

  it("requires a Resend API key when the Resend driver is selected", () => {
    expect(() => createMailService({ MAIL_DRIVER: "resend" })).toThrow(
      "RESEND_MAIL_API_KEY is required",
    );
  });

  it("rejects blank Resend API keys", () => {
    expect(() => createMailService({ MAIL_DRIVER: "resend", RESEND_MAIL_API_KEY: "   " })).toThrow(
      "RESEND_MAIL_API_KEY is required",
    );
  });

  it("logs plaintext mail body and redacts sensitive metadata keys", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = createMailService({ MAIL_DRIVER: "log" });

    await service.send({
      to: "grace@example.com",
      subject: "Verify your email",
      text: "https://app.example.com/verify-email?token=secret",
      metadata: { kind: "email_verification", verificationUrl: "https://app.example.com/verify-email?token=secret" },
    });

    expect(log).toHaveBeenCalledWith(
      "email.send",
      expect.objectContaining({
        text: expect.stringContaining("https://app.example.com/verify-email?token=secret"),
        metadata: {
          kind: "email_verification",
          verificationUrl: "[redacted]",
        },
      }),
    );
  });

  it("includes reply_to and the idempotency header in the Resend request when set", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(PROVIDER_ACCEPTED_BODY, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = resendDriver();

    await driver.send({
      to: "ada@example.com",
      from: { email: "noreply@example.com" },
      replyTo: "visitor@example.com",
      subject: "Contact request",
      text: "Hello",
      idempotencyKey: "routine-action:conv_1:contact.send:hash",
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    const body = JSON.parse(init!.body as string);
    expect(body.reply_to).toBe("visitor@example.com");
    expect(init!.headers).toMatchObject({
      "Idempotency-Key": "routine-action:conv_1:contact.send:hash",
    });
  });

  it("tags a Resend message with its kind so delivery can be measured per email type", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(PROVIDER_ACCEPTED_BODY, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = resendDriver();

    await driver.send({
      to: "ada@example.com",
      from: { email: "noreply@example.com" },
      subject: "Reset your password",
      text: "Hello",
      kind: "password_reset",
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { tags?: unknown };
    expect(body.tags).toEqual([{ name: "kind", value: "password_reset" }]);
  });

  it("adds RFC 8058 one-click unsubscribe headers without putting the URL in transport logs", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(PROVIDER_ACCEPTED_BODY, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await resendDriver().send({
      to: "ada@example.com",
      from: { email: "noreply@example.com" },
      subject: "Operator notice",
      text: "Hello",
      kind: "operator_notice",
      listUnsubscribeUrl: "https://api.example.com/revoke?token=signed",
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { headers?: unknown };
    expect(body.headers).toEqual({
      "List-Unsubscribe": "<https://api.example.com/revoke?token=signed>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("omits Resend tags when a message declares no kind", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(PROVIDER_ACCEPTED_BODY, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = resendDriver();

    await driver.send({
      to: "ada@example.com",
      from: { email: "noreply@example.com" },
      subject: "Hi",
      text: "Hello",
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { tags?: unknown };
    expect(body.tags).toBeUndefined();
  });

  it("logs the message kind so local deliveries are identifiable", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = createMailService({ MAIL_DRIVER: "log" });

    await service.send({
      to: "ada@example.com",
      subject: "Verify your email",
      text: "Hello",
      kind: "email_verification",
    });

    expect(log).toHaveBeenCalledWith("email.send", expect.objectContaining({
      kind: "email_verification",
    }));
  });

  it("throws sanitized Resend delivery errors without provider response text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        name: "validation_error",
        message: "The from domain radioso.dev is not verified for ada@example.com",
      }), { status: 403 }),
    ));
    const driver = resendDriver();

    let error: unknown;
    try {
      await driver.send({
        to: "ada@example.com",
        from: { email: "noreply@radioso.dev" },
        subject: "Verify your email",
        text: "Hello",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ResendEmailDeliveryError);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(error).toMatchObject({
      statusCode: 403,
      providerErrorName: "validation_error",
      outcome: "rejected",
      code: "rejected",
    });
    expect(error).toMatchObject({ message: "Resend email delivery failed with status 403" });
    expect(String((error as Error | undefined)?.message)).not.toContain("radioso.dev");
    expect(String((error as Error | undefined)?.message)).not.toContain("ada@example.com");
  });
  it("logs only redacted facts about a channel reply on the log driver", async () => {
    const spies = consoleSpies();
    const driver = driverOf(createMailService({ MAIL_DRIVER: "log" }));

    const result = await driver.send(channelReply());

    expect(result).toEqual({ dispatched: false, driver: "log", providerMessageId: null, deliveredMessageId: null });
    const info = spies[0];
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual([
      "email.send",
      {
        kind: "channel_reply",
        idempotencyKeyHash: expect.stringMatching(/^[0-9a-f]{16}$/),
        toBytes: Buffer.byteLength(CHANNEL_REPLY_SECRETS.to, "utf8"),
        subjectBytes: Buffer.byteLength(CHANNEL_REPLY_SECRETS.subject, "utf8"),
        textBytes: Buffer.byteLength(CHANNEL_REPLY_SECRETS.text, "utf8"),
        hasHtml: true,
        hasThreading: true,
      },
    ]);
    const logged = everythingLogged(spies);
    for (const secret of Object.values(CHANNEL_REPLY_SECRETS)) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toContain("conv_1");
  });

  it("logs only redacted facts about confirmation and unsubscribe-bearing notices", async () => {
    const spies = consoleSpies();
    const driver = driverOf(createMailService({ MAIL_DRIVER: "log" }));
    const address = "francesco@example.com";
    const confirmToken = "confirm-token-that-must-not-be-logged";
    const revokeToken = "revoke-token-that-must-not-be-logged";

    await driver.send({
      to: address,
      from: { email: "noreply@example.com" },
      kind: "recipient_confirmation",
      subject: "Confirm notifications",
      text: `https://api.example.com/confirm?token=${confirmToken}`,
      listUnsubscribeUrl: `https://api.example.com/revoke?token=${revokeToken}`,
      idempotencyKey: "notification-recipient-confirmation:private",
    });
    await driver.send({
      to: address,
      from: { email: "noreply@example.com" },
      kind: "operator_notice",
      subject: "Routine ending",
      text: "Private notification",
      listUnsubscribeUrl: `https://api.example.com/revoke?token=${revokeToken}`,
      idempotencyKey: "operator-notice:private",
    });

    const logged = everythingLogged(spies);
    expect(logged).not.toContain(address);
    expect(logged).not.toContain(confirmToken);
    expect(logged).not.toContain(revokeToken);
    expect(spies[0]).toHaveBeenCalledWith("email.send", expect.objectContaining({
      kind: "recipient_confirmation",
      idempotencyKeyHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      toBytes: Buffer.byteLength(address, "utf8"),
    }));
  });

  it("hashes a channel reply's idempotency key the same way every time", async () => {
    const spies = consoleSpies();
    const driver = driverOf(createMailService({ MAIL_DRIVER: "log" }));

    await driver.send(channelReply());
    await driver.send(channelReply());
    await driver.send({ ...channelReply(), idempotencyKey: null, html: undefined, threading: null });

    const records = spies[0].mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(records[0]?.idempotencyKeyHash).toBe(records[1]?.idempotencyKeyHash);
    expect(records[2]).toMatchObject({ idempotencyKeyHash: null, hasHtml: false, hasThreading: false });
  });

  it("writes nothing about a channel reply on the noop driver", async () => {
    const spies = consoleSpies();
    const driver = driverOf(createMailService({ MAIL_DRIVER: "noop" }));

    const result = await driver.send(channelReply());

    expect(result).toEqual({ dispatched: false, driver: "noop", providerMessageId: null, deliveredMessageId: null });
    for (const secret of Object.values(CHANNEL_REPLY_SECRETS)) {
      expect(everythingLogged(spies)).not.toContain(secret);
    }
  });

  it("keeps logging transactional mail in full on the log driver", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = createMailService({ MAIL_DRIVER: "log" });

    await service.send({
      to: "ada@example.com",
      replyTo: null,
      subject: "Reset your password",
      text: "https://app.example.com/reset?token=secret",
      kind: "password_reset",
      idempotencyKey: "reset:1",
    });

    expect(log).toHaveBeenCalledWith("email.send", {
      to: "ada@example.com",
      replyTo: null,
      subject: "Reset your password",
      kind: "password_reset",
      text: "https://app.example.com/reset?token=secret",
      metadata: undefined,
      idempotencyKey: "reset:1",
    });
  });

  it.each(["log", "noop"])("finds no sent email on the %s driver", async (driverName) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const driver = driverOf(createMailService({ MAIL_DRIVER: driverName }));

    expect(await driver.lookup("01a101f5-b214-78b7-9004-18f685cb0238")).toBeNull();
  });

  it("still accepts a null display name and a null reply-to", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(PROVIDER_ACCEPTED_BODY, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createMailService({ MAIL_DRIVER: "resend", RESEND_MAIL_API_KEY: "re_test" });

    const result = await service.send({
      to: "ada@example.com",
      from: { email: "support@acme.test", name: null },
      replyTo: null,
      subject: "Hi",
      text: "Hello",
    });

    expect(result.dispatched).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.from).toBe("support@acme.test");
    expect(body).not.toHaveProperty("reply_to");
  });

  it("defaults a service without a configured sender name to a null display name", async () => {
    const driver = new RecordingEmailDriver();
    const service = new EmailService(driver, { fromEmail: "noreply@example.com" });

    await service.send({ to: "ada@example.com", subject: "Hi", text: "Hello" });

    expect(driver.messages[0]?.from).toEqual({ email: "noreply@example.com", name: null });
  });

  it("classifies a send failure without carrying any message content", () => {
    const error = new EmailSendError("unknown", "timeout");

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "EmailSendError", outcome: "unknown", code: "timeout" });
    expect(error.message).toBe("timeout");
  });
});

describe("mail driver selection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const LETTERMINT_TOKEN = "lm_project_SECRET_0123456789";

  it("builds a Lettermint-backed service when MAIL_DRIVER is lettermint", () => {
    const service = createMailService({ MAIL_DRIVER: "lettermint", LETTERMINT_PROJECT_TOKEN: LETTERMINT_TOKEN });

    expect(driverOf(service)).toBeInstanceOf(LettermintEmailDriver);
  });

  it("infers Lettermint when only a Lettermint project token is set", () => {
    expect(driverOf(createMailService({ LETTERMINT_PROJECT_TOKEN: LETTERMINT_TOKEN }))).toBeInstanceOf(LettermintEmailDriver);
  });

  it("keeps inferring Resend when only a Resend key is set", () => {
    expect(driverOf(createMailService({ RESEND_MAIL_API_KEY: "re_test" }))).toBeInstanceOf(ResendEmailDriver);
  });

  it("keeps Resend when both providers are configured without MAIL_DRIVER, as before Lettermint existed", () => {
    const service = createMailService({ RESEND_MAIL_API_KEY: "re_test", LETTERMINT_PROJECT_TOKEN: LETTERMINT_TOKEN });

    expect(driverOf(service)).toBeInstanceOf(ResendEmailDriver);
  });

  it.each([
    ["lettermint", LettermintEmailDriver],
    ["resend", ResendEmailDriver],
  ])("lets MAIL_DRIVER=%s choose when both providers are configured", (driverName, driverClass) => {
    const service = createMailService({
      MAIL_DRIVER: driverName,
      RESEND_MAIL_API_KEY: "re_test",
      LETTERMINT_PROJECT_TOKEN: LETTERMINT_TOKEN,
    });

    expect(driverOf(service)).toBeInstanceOf(driverClass);
  });

  it.each([undefined, "   "])("requires a Lettermint project token when the Lettermint driver is selected (%j)", (token) => {
    expect(() => createMailService({ MAIL_DRIVER: "lettermint", LETTERMINT_PROJECT_TOKEN: token })).toThrow(
      "LETTERMINT_PROJECT_TOKEN is required when MAIL_DRIVER is lettermint",
    );
  });

  it.each(["", "  "])("treats a blank MAIL_DRIVER (%j) as unset", (driverName) => {
    expect(driverOf(createMailService({ MAIL_DRIVER: driverName, LETTERMINT_PROJECT_TOKEN: LETTERMINT_TOKEN })))
      .toBeInstanceOf(LettermintEmailDriver);
  });

  it("sends Lettermint transactional mail with the project token", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ message_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479", status: "pending" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createMailService({ MAIL_DRIVER: "lettermint", LETTERMINT_PROJECT_TOKEN: ` ${LETTERMINT_TOKEN} ` });

    const result = await service.send({ to: "ada@example.com", subject: "Reset your password", text: "Hello", kind: "password_reset" });

    expect(result).toEqual({
      dispatched: true,
      driver: "lettermint",
      providerMessageId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      deliveredMessageId: null,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.lettermint.co/v1/send");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-lettermint-token": LETTERMINT_TOKEN });
  });
});

describe("delivery webhook verifier selection", () => {
  const SECRET = `whsec_${Buffer.from("delivery-webhook-signing-secret").toString("base64")}`;
  const SECRETS = { current: SECRET, previous: null };
  const NOW = new Date("2025-08-08T20:15:12.000Z");
  const TIMESTAMP = Math.floor(NOW.getTime() / 1000);
  const body = Buffer.from(JSON.stringify({
    id: "9b0c4a4e-4e29-4d8b-8b3a-3f0f3e6d2f9b",
    event: "message.delivered",
    timestamp: NOW.toISOString(),
    data: { message_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479", recipient: "ada@example.com", tags: [] },
  }));
  const lettermintSigned = {
    rawBody: body,
    headers: {
      "x-lettermint-signature": `t=${TIMESTAMP},v1=${createHmac("sha256", SECRET).update(`${TIMESTAMP}.`).update(body).digest("hex")}`,
      "x-lettermint-delivery": String(TIMESTAMP),
    },
    now: NOW,
  };

  it.each<[MailWebhookEnv, DeliveryWebhookVerifier["provider"]]>([
    [{ MAIL_DRIVER: "lettermint" }, "lettermint"],
    [{ LETTERMINT_PROJECT_TOKEN: "lm_project_x" }, "lettermint"],
    [{ MAIL_DRIVER: "resend" }, "resend"],
    [{ RESEND_MAIL_API_KEY: "re_test" }, "resend"],
    [{ MAIL_DRIVER: "log" }, "resend"],
    [{}, "resend"],
  ])("selects the verifier of the transactional driver %j resolves to", (source, provider) => {
    expect(deliveryWebhookVerifierFor(source, SECRETS).provider).toBe(provider);
  });

  it("verifies a Lettermint-signed delivery when the transactional driver is lettermint", () => {
    const verifier = deliveryWebhookVerifierFor({ MAIL_DRIVER: "lettermint" }, SECRETS);

    expect(verifier.verify(lettermintSigned)).toMatchObject({
      ok: true,
      event: { kind: "delivery_status", status: { type: "delivered" }, recipients: ["ada@example.com"] },
    });
  });

  it("keeps verifying with Resend's scheme otherwise", () => {
    const verifier = deliveryWebhookVerifierFor({ RESEND_MAIL_API_KEY: "re_test" }, SECRETS);

    expect(verifier.verify(lettermintSigned)).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("disagrees with createMailService on nothing: both providers configured without MAIL_DRIVER resolve to Resend in both", () => {
    const both = { RESEND_MAIL_API_KEY: "re_test", LETTERMINT_PROJECT_TOKEN: "lm_project_x" };

    expect(deliveryWebhookVerifierFor(both, SECRETS).provider).toBe("resend");
    expect(driverOf(createMailService(both))).toBeInstanceOf(ResendEmailDriver);
  });
});
