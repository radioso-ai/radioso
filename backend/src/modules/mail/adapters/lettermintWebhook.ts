import { createHmac, timingSafeEqual } from "node:crypto";

import { parseRfcMessageId } from "../emailHeaderValues.js";
import type {
  DeliveryStatusFacts,
  InboundEnvelope,
  InboundVerification,
  VerifiedInboundEvent,
} from "../inboundEmailReceiver.js";
import { isRecord } from "./lettermintApi.js";
import type { WebhookSigningSecrets } from "./resendWebhook.js";

/**
 * Lettermint's webhook wire format. `X-Lettermint-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]` is
 * HMAC-SHA256 over `"{t}." + raw body`, keyed with the signing secret exactly as configured
 * (`whsec_` prefix included, never decoded). `X-Lettermint-Delivery` must equal the signed `t`.
 * The envelope is `{id, event, timestamp, data}`; `id` is stable across retries of one delivery.
 */

type VerifyRequest = {
  rawBody: Buffer;
  headers: Readonly<Record<string, string | undefined>>;
  now: Date;
};

const SIGNATURE_HEADER = "x-lettermint-signature";
const DELIVERY_HEADER = "x-lettermint-delivery";
const TOLERANCE_SECONDS = 5 * 60;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const UNIX_SECONDS = /^\d{1,12}$/;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

export class LettermintWebhookVerifier {
  private readonly secrets: readonly string[];

  constructor(secrets: WebhookSigningSecrets) {
    const configured = [secrets.current, secrets.previous ?? ""].map((secret) => secret.trim());
    if (!configured[0]) {
      throw new Error("A webhook signing secret is required");
    }
    this.secrets = configured.filter((secret) => secret.length > 0);
  }

  verify(request: VerifyRequest): InboundVerification {
    const headers = lowerCaseHeaders(request.headers);
    const signature = headers.get(SIGNATURE_HEADER);
    const delivery = headers.get(DELIVERY_HEADER);
    if (!signature || !delivery) {
      return { ok: false, reason: "missing_signature" };
    }
    const parsed = parseSignatureHeader(signature);
    if (!parsed || parsed.timestamp !== delivery || !this.matchesAnySecret(parsed, request.rawBody)) {
      return { ok: false, reason: "bad_signature" };
    }
    if (Math.abs(request.now.getTime() / 1000 - Number(parsed.timestamp)) > TOLERANCE_SECONDS) {
      return { ok: false, reason: "stale_timestamp" };
    }
    const event = parseLettermintEvent(request.rawBody);
    return event ? { ok: true, event } : { ok: false, reason: "malformed_payload" };
  }

  private matchesAnySecret(signature: ParsedSignature, rawBody: Buffer): boolean {
    return this.secrets.some((secret) => {
      const expected = createHmac("sha256", secret).update(`${signature.timestamp}.`).update(rawBody).digest();
      return signature.candidates.some((candidate) => timingSafeEqual(candidate, expected));
    });
  }
}

interface ParsedSignature {
  timestamp: string;
  /** Every well-formed `v1` digest; Lettermint may send several at once. */
  candidates: readonly Buffer[];
}

/** Exactly one numeric `t` and at least one 64-hex-digit `v1`; anything else is malformed. */
const parseSignatureHeader = (header: string): ParsedSignature | null => {
  if (!PRINTABLE_ASCII.test(header)) {
    return null;
  }
  const timestamps: string[] = [];
  const candidates: Buffer[] = [];
  for (const part of header.split(",")) {
    const entry = part.trim();
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (key === "t") {
      timestamps.push(value);
    } else if (key === "v1" && HEX_SHA256.test(value)) {
      candidates.push(Buffer.from(value, "hex"));
    }
  }
  const [timestamp] = timestamps;
  return timestamps.length === 1 && timestamp !== undefined && UNIX_SECONDS.test(timestamp) && candidates.length > 0
    ? { timestamp, candidates }
    : null;
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

const DELIVERY_STATUS_BY_EVENT: ReadonlyMap<string, DeliveryStatusFacts["type"]> = new Map([
  ["message.sent", "sent"],
  ["message.delivered", "delivered"],
  ["message.soft_bounced", "delivery_delayed"],
  ["message.hard_bounced", "bounced"],
  ["message.spam_complaint", "complained"],
  ["message.failed", "failed"],
  ["message.policy_rejected", "failed"],
  ["message.suppressed", "suppressed"],
]);

const RECEIVED_EVENT = "message.inbound";
/** The tag every driver puts the email kind under. */
const KIND_TAG = "kind";

const parseLettermintEvent = (rawBody: Buffer): VerifiedInboundEvent | null => {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }
  const providerEventId = nonEmptyString(payload.id);
  const providerType = nonEmptyString(payload.event);
  const occurredAt = dateOf(payload.timestamp);
  if (!providerEventId || !providerType || !occurredAt) {
    return null;
  }
  const data = isRecord(payload.data) ? payload.data : null;
  const messageId = data ? nonEmptyString(data.message_id) : null;

  if (providerType === RECEIVED_EVENT) {
    return data && messageId
      ? { kind: "message_received", providerEventId, providerObjectId: messageId, occurredAt, envelope: envelopeOf(data) }
      : null;
  }
  const deliveryType = DELIVERY_STATUS_BY_EVENT.get(providerType);
  if (deliveryType) {
    return data && messageId
      ? {
          kind: "delivery_status",
          providerEventId,
          providerObjectId: messageId,
          occurredAt,
          status: { type: deliveryType, bounce: bounceOf(deliveryType, data) },
          recipients: recipientsOf(data),
          emailKind: tagValue(data.tags, KIND_TAG),
          rfcMessageId: rfcMessageIdOf(data),
        }
      : null;
  }
  return { kind: "unsupported", providerEventId, occurredAt, providerType };
};

/** `recipient` is the SMTP envelope recipient, the routing field; `to`/`cc` are the visible headers. */
const envelopeOf = (data: Record<string, unknown>): InboundEnvelope => ({
  from: isRecord(data.from) ? nonEmptyString(data.from.email) : null,
  to: addressesOf(data.to),
  cc: addressesOf(data.cc),
  receivedFor: recipientsOf(data),
  subject: typeof data.subject === "string" ? data.subject : null,
  rfcMessageId: headerValue(data.headers, "message-id"),
});

/**
 * The RFC `Message-ID` Lettermint preserved from the send, from the echoed headers of a delivery
 * event (#1619): the `rfcMessageId` fallback that settles a send whose provider id this deployment
 * never recorded. Validated the same way an outbound id is minted (`rfcMessageId`), so a header
 * that is absent, or not a well-formed Message-ID, is dropped rather than compared loosely.
 */
const rfcMessageIdOf = (data: Record<string, unknown>): string | null => {
  const raw = headerValue(data.headers, "message-id");
  return raw ? parseRfcMessageId(raw) : null;
};

/** Bounce reason codes are short tokens; anything else is not echoed (FR-045). */
const PROVIDER_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** RFC 3463 enhanced status code, the only part of an SMTP reply that is kept. */
const ENHANCED_STATUS_CODE = /^[245]\.\d{1,3}\.\d{1,3}$/;

/**
 * A hard bounce is reported as `Permanent` and a soft one as `Transient`, the bounce types the
 * channel and notification suppression already read. `response.content` is never kept: the SMTP
 * reply can quote the recipient (FR-045).
 */
const bounceOf = (
  type: DeliveryStatusFacts["type"],
  data: Record<string, unknown>,
): DeliveryStatusFacts["bounce"] => {
  if (type === "bounced" || type === "delivery_delayed") {
    return {
      type: type === "bounced" ? "Permanent" : "Transient",
      subType: null,
      statusCode: enhancedStatusCodeOf(data.response),
    };
  }
  if (type === "suppressed") {
    return { type: providerToken(data.reason) ?? "unknown", subType: null, statusCode: null };
  }
  return null;
};

const enhancedStatusCodeOf = (response: unknown): string | null => {
  const code = isRecord(response) ? response.enhanced_status_code : null;
  return typeof code === "string" && ENHANCED_STATUS_CODE.test(code.trim()) ? code.trim() : null;
};

const recipientsOf = (data: Record<string, unknown>): string[] => {
  const recipient = nonEmptyString(data.recipient);
  return recipient ? [recipient] : [];
};

const addressesOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry: unknown) => {
        const email = isRecord(entry) ? nonEmptyString(entry.email) : null;
        return email ? [email] : [];
      })
    : [];

/** `{name, value}` pairs; header names compare case-insensitively, tag names exactly. */
const headerValue = (headers: unknown, lowerCaseName: string): string | null =>
  pairValue(headers, (name) => name.toLowerCase() === lowerCaseName);

const tagValue = (tags: unknown, name: string): string | null => pairValue(tags, (candidate) => candidate === name);

const pairValue = (pairs: unknown, matches: (name: string) => boolean): string | null => {
  if (!Array.isArray(pairs)) {
    return null;
  }
  const pair: unknown = pairs.find((entry: unknown) => isRecord(entry) && typeof entry.name === "string" && matches(entry.name));
  return isRecord(pair) ? nonEmptyString(pair.value) : null;
};

const providerToken = (value: unknown): string | null =>
  typeof value === "string" && PROVIDER_TOKEN.test(value) ? value : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const dateOf = (value: unknown): Date | null => {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
