import { createHash } from "node:crypto";

import { ResendApiClient } from "./adapters/resendApi.js";
import { ResendEmailDriver } from "./adapters/resendDriver.js";
import type { RfcMessageId } from "./emailHeaderValues.js";

/**
 * What a message is, as opposed to what it says. Carried to the provider as a delivery tag so
 * bounce and complaint rates can be read per email type rather than for the account as a whole.
 * Values are provider tag names: ASCII letters, numbers and underscores only.
 *
 * `channel_reply` is a reply to a customer over the email channel. Its content is the customer's
 * conversation, so no driver ever logs its addresses, subject, body or headers (FR-045).
 */
export type EmailKind =
  | "email_verification"
  | "password_reset"
  | "account_invitation"
  | "conversation_transfer"
  | "usage_alert"
  | "billing_notice"
  | "channel_reply";

/** The threading headers of an email-channel reply. `autoSubmitted` is set for agent-authored mail only (RFC 3834). */
export interface OutboundThreadingHeaders {
  messageId: RfcMessageId;
  inReplyTo: RfcMessageId | null;
  references: readonly RfcMessageId[];
  autoSubmitted: "auto-generated" | null;
}

export interface EmailMessage {
  to: string;
  from: {
    email: string;
    name?: string | null;
  };
  replyTo?: string | null;
  subject: string;
  text: string;
  html?: string;
  kind?: EmailKind;
  /** Local-delivery debugging only. The log driver prints it; no provider ever receives it. */
  metadata?: Record<string, string>;
  idempotencyKey?: string | null;
  threading?: OutboundThreadingHeaders | null;
}

export interface EmailSendResult {
  /**
   * True only when a mail provider accepted the message. Drivers that merely record it
   * report false, so no caller can claim an unsent message reached its recipient.
   */
  dispatched: boolean;
  /** The provider's id for the accepted message; null when nothing was dispatched or the id is unknown. */
  providerMessageId: string | null;
  /**
   * The Message-ID the recipient receives, when the provider reports it at send time. A provider
   * that rewrites the supplied id reports it only later, through `EmailDriver.lookup`.
   */
  deliveredMessageId: RfcMessageId | null;
}

/** A provider's latest delivery event for a sent message; `unknown` covers any it does not name. */
export type SentEmailLastEvent =
  | "queued"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "failed"
  | "suppressed"
  | "unknown";

export interface SentEmailStatus {
  providerMessageId: string;
  /** Null until the provider has handed the message on and assigned its final Message-ID. */
  deliveredMessageId: RfcMessageId | null;
  lastEvent: SentEmailLastEvent;
}

export interface EmailDriver {
  /** Throws `EmailSendError`. */
  send(message: EmailMessage): Promise<EmailSendResult>;
  /**
   * The provider's current view of a sent message, or null when it has none. Drivers that never
   * dispatch return null. Throws `EmailLookupError`.
   */
  lookup(providerMessageId: string): Promise<SentEmailStatus | null>;
}

export class EmailService {
  constructor(
    private readonly driver: EmailDriver,
    private readonly defaults: {
      fromEmail: string;
      fromName?: string | null;
    },
  ) {}

  async send(
    message: Omit<EmailMessage, "from"> & { from?: EmailMessage["from"] },
  ): Promise<EmailSendResult> {
    const normalized: EmailMessage = {
      ...message,
      from: message.from ?? {
        email: this.defaults.fromEmail,
        name: this.defaults.fromName ?? null,
      },
    };
    return this.driver.send(normalized);
  }
}

const undispatched = (): EmailSendResult => ({
  dispatched: false,
  providerMessageId: null,
  deliveredMessageId: null,
});

class NoopEmailDriver implements EmailDriver {
  async send(_message: EmailMessage): Promise<EmailSendResult> {
    return undispatched();
  }

  async lookup(_providerMessageId: string): Promise<SentEmailStatus | null> {
    return null;
  }
}

const SENSITIVE_METADATA_KEYS = new Set(["resetUrl", "verificationUrl"]);

const redactSensitiveEmailMetadata = (
  metadata: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      SENSITIVE_METADATA_KEYS.has(key) ? "[redacted]" : value,
    ]),
  );
};

/**
 * The only facts recorded about a channel reply: shape, never content. The idempotency key is
 * hashed so local runs can correlate retries without printing the key.
 */
const redactedChannelReply = (message: EmailMessage) => ({
  kind: message.kind,
  idempotencyKeyHash: message.idempotencyKey ? shortHash(message.idempotencyKey) : null,
  textBytes: Buffer.byteLength(message.text, "utf8"),
  hasHtml: Boolean(message.html),
  hasThreading: Boolean(message.threading),
});

const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

class LogEmailDriver implements EmailDriver {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (message.kind === "channel_reply") {
      console.info("email.send", redactedChannelReply(message));
      return undispatched();
    }
    console.info("email.send", {
      to: message.to,
      replyTo: message.replyTo ?? null,
      subject: message.subject,
      kind: message.kind ?? null,
      text: message.text,
      metadata: redactSensitiveEmailMetadata(message.metadata),
      idempotencyKey: message.idempotencyKey ?? null,
    });
    return undispatched();
  }

  async lookup(_providerMessageId: string): Promise<SentEmailStatus | null> {
    return null;
  }
}

interface MailEnv {
  MAIL_DRIVER?: string;
  MAIL_FROM_EMAIL?: string;
  MAIL_FROM_NAME?: string;
  RESEND_MAIL_API_KEY?: string;
}

export const createMailService = (source: MailEnv = process.env): EmailService => {
  const resendApiKey = source.RESEND_MAIL_API_KEY?.trim();
  const driverName = source.MAIL_DRIVER ?? (resendApiKey ? "resend" : "log");
  const fromEmail = source.MAIL_FROM_EMAIL ?? "noreply@example.com";
  const fromName = source.MAIL_FROM_NAME ?? "Radioso";

  if (driverName === "resend") {
    if (!resendApiKey) {
      throw new Error("RESEND_MAIL_API_KEY is required when MAIL_DRIVER is resend");
    }
    const driver = new ResendEmailDriver({ api: new ResendApiClient({ apiKey: resendApiKey }) });
    return new EmailService(driver, { fromEmail, fromName });
  }
  if (driverName === "noop") {
    return new EmailService(new NoopEmailDriver(), { fromEmail, fromName });
  }
  if (driverName === "log") {
    return new EmailService(new LogEmailDriver(), { fromEmail, fromName });
  }
  throw new Error(`Unsupported MAIL_DRIVER "${driverName}"`);
};
