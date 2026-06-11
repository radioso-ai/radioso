import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createSignedWebhookHeaders,
  verifyWebhookSignature,
} from "../../src/modules/chat/services/actions/webhookDelivery.js";

describe("webhook delivery signing", () => {
  it("signs the raw body with timestamped HMAC headers and verifies the same bytes", () => {
    const rawBody = JSON.stringify({ data: { email: "alex@example.com" } });
    const timestamp = "1781200000";
    const headers = createSignedWebhookHeaders({
      rawBody,
      secret: "receiver-secret",
      idempotencyKey: "routine-action:conv_1:webhook.send:hash",
      timestamp,
    });

    const expectedDigest = createHmac("sha256", "receiver-secret")
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    expect(headers).toEqual({
      "Idempotency-Key": "routine-action:conv_1:webhook.send:hash",
      "X-Radioso-Timestamp": timestamp,
      "X-Radioso-Signature": `sha256=${expectedDigest}`,
    });
    expect(verifyWebhookSignature({
      rawBody,
      secret: "receiver-secret",
      timestamp,
      signatureHeader: headers["X-Radioso-Signature"],
    })).toBe(true);
  });

  it("rejects tampered bodies and wrong secrets", () => {
    const rawBody = JSON.stringify({ data: { email: "alex@example.com" } });
    const timestamp = "1781200000";
    const headers = createSignedWebhookHeaders({
      rawBody,
      secret: "receiver-secret",
      idempotencyKey: "idempotency-1",
      timestamp,
    });

    expect(verifyWebhookSignature({
      rawBody: JSON.stringify({ data: { email: "mallory@example.com" } }),
      secret: "receiver-secret",
      timestamp,
      signatureHeader: headers["X-Radioso-Signature"],
    })).toBe(false);
    expect(verifyWebhookSignature({
      rawBody,
      secret: "wrong-secret",
      timestamp,
      signatureHeader: headers["X-Radioso-Signature"],
    })).toBe(false);
  });
});
