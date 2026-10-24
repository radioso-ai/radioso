import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LettermintWebhookVerifier } from "../../../src/modules/mail/public.js";

const WEBHOOK_FIXTURES = fileURLToPath(
  new URL("../../fixtures/email-channel/lettermint/webhooks/", import.meta.url),
);
const CURRENT_SECRET = "whsec_currentLettermintSigningSecret0000";
const PREVIOUS_SECRET = "whsec_previousLettermintSigningSecret000";
const SIGNED_AT = new Date("2025-10-02T14:30:00.000Z");

const fixtureText = (name: string): string => readFileSync(`${WEBHOOK_FIXTURES}${name}`, "utf8");

const webhookBody = (name: string, edit?: (payload: Record<string, unknown>) => void): Buffer => {
  const payload = JSON.parse(fixtureText(name)) as Record<string, unknown>;
  edit?.(payload);
  return Buffer.from(JSON.stringify(payload));
};

const dataOf = (payload: Record<string, unknown>): Record<string, unknown> =>
  payload.data as Record<string, unknown>;

/** Lettermint signs `"{t}." + raw body` with the secret as is, `whsec_` prefix included. */
const signatureFor = (secret: string, timestamp: number, body: Buffer): string =>
  createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");

const signedRequest = (
  body: Buffer,
  options: { secret?: string; signedAt?: Date; now?: Date } = {},
) => {
  const timestamp = Math.floor((options.signedAt ?? SIGNED_AT).getTime() / 1000);
  return {
    rawBody: body,
    headers: {
      "x-lettermint-signature": `t=${timestamp},v1=${signatureFor(options.secret ?? CURRENT_SECRET, timestamp, body)}`,
      "x-lettermint-delivery": String(timestamp),
      "x-lettermint-event": "message.inbound",
      "x-lettermint-attempt": "1",
    } as Record<string, string | undefined>,
    now: options.now ?? options.signedAt ?? SIGNED_AT,
  };
};

const verifier = new LettermintWebhookVerifier({ current: CURRENT_SECRET, previous: PREVIOUS_SECRET });

const verifiedEvent = (body: Buffer) => {
  const result = verifier.verify(signedRequest(body));
  if (!result.ok) throw new Error(`expected a verified event, got ${result.reason}`);
  return result.event;
};

describe("Lettermint webhook: signature", () => {
  it("accepts a delivery signed with the current secret", () => {
    expect(verifier.verify(signedRequest(webhookBody("message.inbound.json"))).ok).toBe(true);
  });

  it("accepts a delivery signed with the previous secret during rotation", () => {
    const request = signedRequest(webhookBody("message.inbound.json"), { secret: PREVIOUS_SECRET });

    expect(verifier.verify(request).ok).toBe(true);
  });

  it("accepts a header carrying several v1 signatures when one matches", () => {
    const request = signedRequest(webhookBody("message.inbound.json"));
    const header = request.headers["x-lettermint-signature"] ?? "";
    const [timestamp, valid] = header.split(",");
    const headers = { ...request.headers, "x-lettermint-signature": `${timestamp},v1=${"0".repeat(64)},${valid}` };

    expect(verifier.verify({ ...request, headers }).ok).toBe(true);
  });

  it("verifies the raw bytes as delivered, not a re-serialization", () => {
    const pretty = Buffer.from(fixtureText("message.inbound.json"));

    expect(verifier.verify(signedRequest(pretty)).ok).toBe(true);
  });

  it("reads its headers case-insensitively", () => {
    const request = signedRequest(webhookBody("message.inbound.json"));
    const headers = {
      "X-Lettermint-Signature": request.headers["x-lettermint-signature"],
      "X-Lettermint-Delivery": request.headers["x-lettermint-delivery"],
    };

    expect(verifier.verify({ ...request, headers }).ok).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    const request = signedRequest(webhookBody("message.inbound.json"), { secret: "whsec_notOurSecret" });

    expect(verifier.verify(request)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("does not base64-decode the secret", () => {
    const decodedKey = Buffer.from(CURRENT_SECRET.slice("whsec_".length), "base64");
    const body = webhookBody("message.inbound.json");
    const timestamp = Math.floor(SIGNED_AT.getTime() / 1000);
    const request = signedRequest(body);
    const forged = createHmac("sha256", decodedKey).update(`${timestamp}.`).update(body).digest("hex");
    const headers = { ...request.headers, "x-lettermint-signature": `t=${timestamp},v1=${forged}` };

    expect(verifier.verify({ ...request, headers })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a body changed after signing", () => {
    const request = signedRequest(webhookBody("message.inbound.json"));
    const tampered = Buffer.from(request.rawBody.toString("utf8").replace("Question about", "Changed"));

    expect(verifier.verify({ ...request, rawBody: tampered })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a delivery header that differs from the signed timestamp", () => {
    const request = signedRequest(webhookBody("message.inbound.json"));
    const delivery = String(Number(request.headers["x-lettermint-delivery"]) + 1);

    const result = verifier.verify({ ...request, headers: { ...request.headers, "x-lettermint-delivery": delivery } });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["no timestamp", (header: string) => header.replace(/^t=\d+,/, "")],
    ["two timestamps", (header: string) => `t=1,${header}`],
    ["a non-numeric timestamp", (header: string) => header.replace(/^t=\d+/, "t=yesterday")],
    ["no v1 entry", (header: string) => header.replace("v1=", "v0=")],
    ["a v1 entry that is not a SHA-256 hex digest", (header: string) => header.replace(/v1=[0-9a-f]+/, "v1=abc")],
  ])("rejects a signature header with %s", (_label, edit) => {
    const request = signedRequest(webhookBody("message.inbound.json"));
    const headers = { ...request.headers, "x-lettermint-signature": edit(request.headers["x-lettermint-signature"] ?? "") };

    expect(verifier.verify({ ...request, headers })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each(["x-lettermint-signature", "x-lettermint-delivery"])("reports a missing %s header", (header) => {
    const request = signedRequest(webhookBody("message.inbound.json"));

    const result = verifier.verify({ ...request, headers: { ...request.headers, [header]: undefined } });

    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it.each([
    ["older", -301 * 1000],
    ["newer", 301 * 1000],
  ])("rejects a validly signed delivery %s than the five-minute tolerance", (_label, skewMs) => {
    const request = signedRequest(webhookBody("message.inbound.json"), {
      now: new Date(SIGNED_AT.getTime() - skewMs),
    });

    expect(verifier.verify(request)).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("accepts a delivery inside the tolerance", () => {
    const request = signedRequest(webhookBody("message.inbound.json"), {
      now: new Date(SIGNED_AT.getTime() + 300 * 1000),
    });

    expect(verifier.verify(request).ok).toBe(true);
  });

  it.each([
    ["not JSON", Buffer.from("{not json")],
    ["a JSON array", Buffer.from("[]")],
    ["no id", webhookBody("message.inbound.json", (payload) => delete payload.id)],
    ["no event", webhookBody("message.inbound.json", (payload) => delete payload.event)],
    ["no timestamp", webhookBody("message.inbound.json", (payload) => delete payload.timestamp)],
    ["an unreadable timestamp", webhookBody("message.inbound.json", (payload) => {
      payload.timestamp = "soon";
    })],
    ["an inbound event without a message id", webhookBody("message.inbound.json", (payload) => {
      delete dataOf(payload).message_id;
    })],
    ["a delivery event without a message id", webhookBody("message.delivered.json", (payload) => {
      delete dataOf(payload).message_id;
    })],
  ])("reports a signed but malformed payload (%s)", (_label, body) => {
    expect(verifier.verify(signedRequest(body))).toEqual({ ok: false, reason: "malformed_payload" });
  });

  it("requires a signing secret", () => {
    expect(() => new LettermintWebhookVerifier({ current: "  ", previous: null })).toThrow(
      "A webhook signing secret is required",
    );
  });
});

describe("Lettermint webhook: event kinds", () => {
  it("maps message.inbound to message_received with the envelope recipient", () => {
    expect(verifiedEvent(webhookBody("message.inbound.json"))).toEqual({
      kind: "message_received",
      providerEventId: "e3d4f5a6-b7c8-9012-d3e4-f5a6b7c89012",
      providerObjectId: "6b1f0c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
      occurredAt: new Date("2025-10-02T14:30:00.000Z"),
      envelope: {
        from: "customer@example.test",
        to: ["support@customer.test"],
        cc: ["billing@customer.test"],
        receivedFor: ["t_9f3c2a7b@in.relay.test"],
        subject: "Question about my order",
        rfcMessageId: "<abc123@mail.example.test>",
      },
    });
  });

  it("never carries the inbound body, attachments or raw URL into the event", () => {
    const rendered = JSON.stringify(verifiedEvent(webhookBody("message.inbound.json")));

    expect(rendered).not.toContain("recent order");
    expect(rendered).not.toContain("storage.lettermint.co");
    expect(rendered).not.toContain("receipt.pdf");
  });

  it("reads the Message-ID header case-insensitively and tolerates its absence", () => {
    const lowerCase = verifiedEvent(webhookBody("message.inbound.json", (payload) => {
      dataOf(payload).headers = [{ name: "message-id", value: "<lower@mail.example.test>" }];
    }));
    const absent = verifiedEvent(webhookBody("message.inbound.json", (payload) => {
      dataOf(payload).headers = [];
    }));

    expect(lowerCase).toMatchObject({ envelope: { rfcMessageId: "<lower@mail.example.test>" } });
    expect(absent).toMatchObject({ envelope: { rfcMessageId: null } });
  });

  it("reports no envelope recipient when the event carries none", () => {
    const event = verifiedEvent(webhookBody("message.inbound.json", (payload) => {
      dataOf(payload).recipient = null;
    }));

    expect(event).toMatchObject({ kind: "message_received", envelope: { receivedFor: [] } });
  });

  it("maps message.delivered to delivered with the recipient and the kind tag", () => {
    expect(verifiedEvent(webhookBody("message.delivered.json"))).toEqual({
      kind: "delivery_status",
      providerEventId: "9b0c4a4e-4e29-4d8b-8b3a-3f0f3e6d2f9b",
      providerObjectId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      occurredAt: new Date("2025-08-08T20:15:12.000Z"),
      status: { type: "delivered", bounce: null },
      recipients: ["ada@example.test"],
      emailKind: "channel_reply",
    });
  });

  it("maps a hard bounce to a permanent bounce keeping only the enhanced status code", () => {
    const event = verifiedEvent(webhookBody("message.hard_bounced.json"));

    expect(event).toEqual({
      kind: "delivery_status",
      providerEventId: "123e4567-e89b-12d3-a456-426614174000",
      providerObjectId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      occurredAt: new Date("2025-08-08T20:15:30.000Z"),
      status: { type: "bounced", bounce: { type: "Permanent", subType: null, statusCode: "5.1.1" } },
      recipients: ["alice@customer.test"],
      emailKind: "contact_notification",
    });
    expect(JSON.stringify(event.kind === "delivery_status" ? event.status : null)).not.toContain("alice@customer.test");
    expect(JSON.stringify(event)).not.toContain("User unknown");
  });

  it("maps a soft bounce to a transient delivery delay without the SMTP reply text", () => {
    const event = verifiedEvent(webhookBody("message.soft_bounced.json"));

    expect(event).toMatchObject({
      kind: "delivery_status",
      status: { type: "delivery_delayed", bounce: { type: "Transient", subType: null, statusCode: "4.2.2" } },
      recipients: ["ada@example.test"],
    });
    expect(JSON.stringify(event)).not.toContain("over quota");
  });

  it("drops an enhanced status code that is not one", () => {
    const event = verifiedEvent(webhookBody("message.hard_bounced.json", (payload) => {
      (dataOf(payload).response as Record<string, unknown>).enhanced_status_code = "alice@customer.test";
    }));

    expect(event).toMatchObject({ status: { bounce: { type: "Permanent", statusCode: null } } });
  });

  it("maps message.suppressed to suppressed carrying only the reason token", () => {
    const event = verifiedEvent(webhookBody("message.suppressed.json"));

    expect(event).toMatchObject({
      kind: "delivery_status",
      status: { type: "suppressed", bounce: { type: "hard_bounce", subType: null, statusCode: null } },
      recipients: ["alice@customer.test"],
      emailKind: "operator_notice",
    });
    expect(JSON.stringify(event.kind === "delivery_status" ? event.status : null)).not.toContain("alice@customer.test");
  });

  it.each([
    ["message.failed.json", "failed"],
    ["message.policy_rejected.json", "failed"],
  ])("maps %s to a %s status without the provider's reason", (fixture, type) => {
    const event = verifiedEvent(webhookBody(fixture));

    expect(event).toMatchObject({ kind: "delivery_status", status: { type, bounce: null } });
    expect(JSON.stringify(event)).not.toContain("Encryption needed");
    expect(JSON.stringify(event)).not.toContain("Spam score");
  });

  it("reports no recipients for an event that names none", () => {
    expect(verifiedEvent(webhookBody("message.policy_rejected.json"))).toMatchObject({ recipients: [] });
  });

  it.each([
    ["message.sent", "sent"],
    ["message.spam_complaint", "complained"],
  ])("maps %s to the %s delivery status", (eventName, type) => {
    const body = webhookBody("message.delivered.json", (payload) => {
      payload.event = eventName;
      delete dataOf(payload).response;
    });

    expect(verifiedEvent(body)).toMatchObject({
      kind: "delivery_status",
      providerObjectId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      status: { type, bounce: null },
    });
  });

  it("reports no kind for a message sent without one", () => {
    const event = verifiedEvent(webhookBody("message.delivered.json", (payload) => {
      dataOf(payload).tags = [{ name: "__lettermint_tag", value: "kind" }];
    }));

    expect(event).toMatchObject({ emailKind: null });
  });

  it.each([
    "message.created",
    "message.opened",
    "message.clicked",
    "message.auto_replied",
    "message.unsubscribed",
    "message.scheduled",
    "message.rescheduled",
    "message.canceled",
    "message.released",
    "suppression.added",
    "suppression.removed",
    "something.new",
  ])("records %s as unsupported", (eventName) => {
    const body = webhookBody("message.delivered.json", (payload) => {
      payload.event = eventName;
    });

    expect(verifiedEvent(body)).toEqual({
      kind: "unsupported",
      providerEventId: "9b0c4a4e-4e29-4d8b-8b3a-3f0f3e6d2f9b",
      occurredAt: new Date("2025-08-08T20:15:12.000Z"),
      providerType: eventName,
    });
  });

  it("records the dashboard's webhook.test as unsupported", () => {
    expect(verifiedEvent(webhookBody("webhook.test.json"))).toEqual({
      kind: "unsupported",
      providerEventId: "test-7f9c8e2a-1b3d-4f6e-b7d2-5c9f3a7e8b0c",
      occurredAt: new Date("2025-08-08T20:14:12.000Z"),
      providerType: "webhook.test",
    });
  });
});
