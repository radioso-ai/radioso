/**
 * Provider port for receiving email. Provider- and transport-only: it verifies a provider webhook
 * and fetches one received message in a provider-neutral shape. It knows nothing about mailboxes,
 * conversations, agents or connectors; deciding what a message means belongs to the email channel.
 */

export type AuthVerdict = "pass" | "fail" | "gray" | "processing_failed" | "unknown";

export interface InboundEnvelope {
  from: string | null;
  to: readonly string[];
  cc: readonly string[];
  receivedFor: readonly string[];
  subject: string | null;
  rfcMessageId: string | null;
}

export interface DeliveryStatusFacts {
  type: "sent" | "delivered" | "delivery_delayed" | "bounced" | "complained" | "failed" | "suppressed";
  bounce: { type: string; subType: string | null; statusCode: string | null } | null;
}

export type VerifiedInboundEvent =
  | {
      kind: "message_received";
      providerEventId: string;
      providerObjectId: string;
      occurredAt: Date;
      envelope: InboundEnvelope;
    }
  | {
      kind: "delivery_status";
      providerEventId: string;
      providerObjectId: string;
      occurredAt: Date;
      status: DeliveryStatusFacts;
    }
  | { kind: "domain_status"; providerEventId: string; providerObjectId: string; occurredAt: Date }
  | { kind: "unsupported"; providerEventId: string; occurredAt: Date; providerType: string };

export type InboundVerification =
  | { ok: true; event: VerifiedInboundEvent }
  | {
      ok: false;
      reason: "missing_signature" | "bad_signature" | "stale_timestamp" | "malformed_payload";
    };

/** One received message, normalized. Attachment bytes are never carried; only the manifest is. */
export interface InboundEmailMessage {
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  from: { address: string; displayName: string | null } | null;
  to: readonly string[];
  cc: readonly string[];
  /** received_for ∪ Delivered-To ∪ X-Original-To */
  deliveredTo: readonly string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  automation: {
    autoSubmitted: string | null;
    precedence: string | null;
    autoResponseSuppress: string | null;
    listId: string | null;
  };
  report: { kind: "delivery_status"; originalMessageIds: readonly string[] } | null;
  attachments: readonly { name: string; contentType: string; sizeBytes: number }[];
  authentication: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
  spamVerdict: "spam" | "not_spam" | "unknown";
  raw: Buffer;
}

/**
 * Consumers: `verify` → the email webhook only. `fetchMessage` → the inbound processor only.
 */
export interface InboundEmailReceiver {
  readonly provider: string;
  verify(request: {
    rawBody: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
    now: Date;
  }): InboundVerification;
  /** Throws `InboundFetchError`. */
  fetchMessage(providerObjectId: string): Promise<InboundEmailMessage>;
}

export class InboundFetchError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(code);
    this.name = "InboundFetchError";
  }
}
