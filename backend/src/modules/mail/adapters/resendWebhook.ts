import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  DeliveryStatusFacts,
  InboundEnvelope,
  InboundVerification,
  VerifiedInboundEvent,
} from "../inboundEmailReceiver.js";
import { isRecord } from "./resendApi.js";

/**
 * Resend's webhook wire format: Svix (Standard Webhooks) signatures over the raw body, and the
 * Resend event envelope. The `local` receiver speaks the same format, so the dev tool and tests
 * exercise exactly the production verification path.
 */

export interface WebhookSigningSecrets {
  current: string;
  /** Accepted alongside `current` while a signing key is being rotated. */
  previous: string | null;
}

type VerifyRequest = {
  rawBody: Buffer;
  headers: Readonly<Record<string, string | undefined>>;
  now: Date;
};

const TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1,";
const UNIX_SECONDS = /^\d{1,12}$/;

export class ResendWebhookVerifier {
  private readonly keys: readonly Buffer[];

  constructor(secrets: WebhookSigningSecrets) {
    const configured = [secrets.current, secrets.previous ?? ""].map((secret) => secret.trim());
    if (!configured[0]) {
      throw new Error("A webhook signing secret is required");
    }
    this.keys = configured.filter((secret) => secret.length > 0).map(decodeSigningSecret);
  }

  verify(request: VerifyRequest): InboundVerification {
    const headers = lowerCaseHeaders(request.headers);
    const id = headers.get("svix-id");
    const timestamp = headers.get("svix-timestamp");
    const signature = headers.get("svix-signature");
    if (!id || !timestamp || !signature) {
      return { ok: false, reason: "missing_signature" };
    }
    if (!UNIX_SECONDS.test(timestamp) || !this.matchesAnyKey(id, timestamp, request.rawBody, signature)) {
      return { ok: false, reason: "bad_signature" };
    }
    if (Math.abs(request.now.getTime() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
      return { ok: false, reason: "stale_timestamp" };
    }
    const event = parseResendEvent(request.rawBody, id);
    return event ? { ok: true, event } : { ok: false, reason: "malformed_payload" };
  }

  private matchesAnyKey(id: string, timestamp: string, rawBody: Buffer, signatureHeader: string): boolean {
    const presented = signatureHeader
      .split(" ")
      .filter((entry) => entry.startsWith(SIGNATURE_VERSION))
      .map((entry) => Buffer.from(entry.slice(SIGNATURE_VERSION.length), "base64"));
    if (presented.length === 0) {
      return false;
    }
    return this.keys.some((key) => {
      const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(rawBody).digest();
      return presented.some(
        (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
      );
    });
  }
}

const decodeSigningSecret = (secret: string): Buffer => {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) {
    throw new Error("A webhook signing secret must be base64 after the whsec_ prefix");
  }
  return key;
};

const lowerCaseHeaders = (headers: Readonly<Record<string, string | undefined>>): Map<string, string> => {
  const lowered = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.trim()) {
      lowered.set(name.toLowerCase(), value.trim());
    }
  }
  return lowered;
};

const DELIVERY_STATUS_BY_EVENT_TYPE: ReadonlyMap<string, DeliveryStatusFacts["type"]> = new Map([
  ["email.sent", "sent"],
  ["email.delivered", "delivered"],
  ["email.delivery_delayed", "delivery_delayed"],
  ["email.bounced", "bounced"],
  ["email.complained", "complained"],
  ["email.failed", "failed"],
  ["email.suppressed", "suppressed"],
]);

const RECEIVED_EVENT_TYPE = "email.received";
const DOMAIN_EVENT_PREFIX = "domain.";

const parseResendEvent = (rawBody: Buffer, providerEventId: string): VerifiedInboundEvent | null => {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }
  const providerType = nonEmptyString(payload.type);
  const occurredAt = dateOf(payload.created_at);
  if (!providerType || !occurredAt) {
    return null;
  }
  const data = isRecord(payload.data) ? payload.data : null;

  if (providerType === RECEIVED_EVENT_TYPE) {
    const emailId = data ? nonEmptyString(data.email_id) : null;
    return data && emailId
      ? { kind: "message_received", providerEventId, providerObjectId: emailId, occurredAt, envelope: envelopeOf(data) }
      : null;
  }
  const deliveryType = DELIVERY_STATUS_BY_EVENT_TYPE.get(providerType);
  if (deliveryType) {
    const emailId = data ? nonEmptyString(data.email_id) : null;
    return data && emailId
      ? {
          kind: "delivery_status",
          providerEventId,
          providerObjectId: emailId,
          occurredAt,
          status: { type: deliveryType, bounce: bounceOf(deliveryType, data) },
        }
      : null;
  }
  if (providerType.startsWith(DOMAIN_EVENT_PREFIX)) {
    const domainId = data ? nonEmptyString(data.id) : null;
    return domainId ? { kind: "domain_status", providerEventId, providerObjectId: domainId, occurredAt } : null;
  }
  return { kind: "unsupported", providerEventId, occurredAt, providerType };
};

const envelopeOf = (data: Record<string, unknown>): InboundEnvelope => ({
  from: nonEmptyString(data.from),
  to: stringsOf(data.to),
  cc: stringsOf(data.cc),
  // The list payload carries `received_for: null`; the event and the GET payload carry an array.
  receivedFor: stringsOf(data.received_for),
  subject: typeof data.subject === "string" ? data.subject : null,
  rfcMessageId: nonEmptyString(data.message_id),
});

/** SES bounce and suppression types are short tokens; anything else is not echoed (FR-045). */
const PROVIDER_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** RFC 3463 enhanced status code, the only part of a bounce message that is kept. */
const ENHANCED_STATUS_CODE = /\b[245]\.\d{1,3}\.\d{1,3}\b/;

const bounceOf = (
  type: DeliveryStatusFacts["type"],
  data: Record<string, unknown>,
): DeliveryStatusFacts["bounce"] => {
  if (type === "bounced" && isRecord(data.bounce)) {
    const message = typeof data.bounce.message === "string" ? data.bounce.message : "";
    return {
      type: providerToken(data.bounce.type) ?? "unknown",
      subType: providerToken(data.bounce.subType),
      statusCode: ENHANCED_STATUS_CODE.exec(message)?.[0] ?? null,
    };
  }
  if (type === "suppressed" && isRecord(data.suppressed)) {
    return { type: providerToken(data.suppressed.type) ?? "unknown", subType: null, statusCode: null };
  }
  return null;
};

const providerToken = (value: unknown): string | null =>
  typeof value === "string" && PROVIDER_TOKEN.test(value) ? value : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

const dateOf = (value: unknown): Date | null => {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
