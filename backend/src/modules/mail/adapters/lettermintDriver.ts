import { EmailHeaderValueError, formatMailbox } from "../emailHeaderValues.js";
import {
  EmailLookupError,
  EmailSendError,
  type EmailProviderFailureCode,
  type EmailSendOutcome,
} from "../emailSendErrors.js";
import type {
  EmailDriver,
  EmailMessage,
  EmailSendResult,
  OutboundThreadingHeaders,
  SentEmailLastEvent,
  SentEmailStatus,
} from "../emailService.js";
import {
  LettermintApiError,
  isRecord,
  type LettermintApiClient,
  type LettermintFailureKind,
} from "./lettermintApi.js";

/**
 * Sends through Lettermint's Sending API with the project token and reads a sent message back
 * through the Team API. A client built with the project token alone is send-only: its `lookup`
 * fails as a non-retryable `auth` error without calling Lettermint. Only the email channel looks
 * messages up, and its configuration always carries the team token.
 */

/**
 * How a failed call bears on whether the message went out, as for Resend. A 409 that names
 * neither idempotency conflict, or cannot be read, may be the in-flight case and leaves the
 * outcome unknown.
 */
const FAILURE_CLASSIFICATION: Readonly<
  Record<LettermintFailureKind, { outcome: EmailSendOutcome; code: EmailProviderFailureCode }>
> = {
  auth: { outcome: "rejected", code: "auth" },
  not_found: { outcome: "rejected", code: "not_found" },
  rejected: { outcome: "rejected", code: "rejected" },
  idempotency_mismatch: { outcome: "rejected", code: "idempotency_body_mismatch" },
  idempotency_in_flight: { outcome: "retryable", code: "idempotency_in_flight" },
  unrecognized_conflict: { outcome: "unknown", code: "unrecognized_conflict" },
  rate_limited: { outcome: "retryable", code: "rate_limited" },
  unavailable: { outcome: "unknown", code: "unavailable" },
  timeout: { outcome: "unknown", code: "timeout" },
  unreachable: { outcome: "unknown", code: "unreachable" },
  malformed_response: { outcome: "unknown", code: "malformed_response" },
};

/**
 * A failed Lettermint send. Carries the HTTP status and Lettermint's error code for delivery logs,
 * but never Lettermint's error message, which can quote addresses and domains (FR-045).
 */
export class LettermintEmailDeliveryError extends EmailSendError {
  readonly statusCode: number | null;
  readonly providerErrorName: string | null;

  constructor(failure: Pick<LettermintApiError, "kind" | "statusCode" | "providerErrorName">) {
    const { outcome, code } = FAILURE_CLASSIFICATION[failure.kind];
    super(
      outcome,
      code,
      failure.statusCode === null
        ? `Lettermint email delivery failed: ${code}`
        : `Lettermint email delivery failed with status ${failure.statusCode}`,
    );
    this.name = "LettermintEmailDeliveryError";
    this.statusCode = failure.statusCode;
    this.providerErrorName = failure.providerErrorName;
  }
}

/** Lettermint's `MessageStatus` against the delivery events every driver reports. */
const LAST_EVENT_BY_STATUS: ReadonlyMap<string, SentEmailLastEvent> = new Map([
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
]);

/** Lettermint replaces a submitted Message-ID unless this control header asks it to keep it. */
const PRESERVE_MESSAGE_ID_HEADER = "X-LM-Preserve-Message-ID";

export class LettermintEmailDriver implements EmailDriver {
  private readonly api: LettermintApiClient;

  constructor(options: { api: LettermintApiClient }) {
    this.api = options.api;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const body = {
      from: senderOf(message),
      to: [message.to],
      reply_to: message.replyTo ? [message.replyTo] : undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
      tags: message.kind ? [{ name: "kind", value: message.kind }] : undefined,
      headers: messageHeaders(message),
    };
    // The supplied Message-ID is preserved, so the delivered id is known before Lettermint answers.
    const deliveredMessageId = message.threading?.messageId ?? null;
    let payload: unknown;
    try {
      payload = await this.api.request("sending", "POST", "/send", {
        body,
        idempotencyKey: message.idempotencyKey,
      });
    } catch (error) {
      if (isUnreadableAcceptance(error)) {
        return { dispatched: true, driver: "lettermint", providerMessageId: null, deliveredMessageId };
      }
      throw error instanceof LettermintApiError ? new LettermintEmailDeliveryError(error) : error;
    }
    return { dispatched: true, driver: "lettermint", providerMessageId: messageIdOf(payload), deliveredMessageId };
  }

  async lookup(providerMessageId: string): Promise<SentEmailStatus | null> {
    if (!providerMessageId) {
      return null;
    }
    let payload: unknown;
    try {
      payload = await this.api.request("team", "GET", `/messages/${encodeURIComponent(providerMessageId)}`);
    } catch (error) {
      if (!(error instanceof LettermintApiError)) {
        throw error;
      }
      if (error.kind === "not_found") {
        return null;
      }
      throw new EmailLookupError(error.retryable, FAILURE_CLASSIFICATION[error.kind].code);
    }
    if (!isRecord(payload)) {
      throw new EmailLookupError(true, "malformed_response");
    }
    return {
      providerMessageId,
      // A message record carries no RFC Message-ID; the channel already holds the one it sent.
      deliveredMessageId: null,
      lastEvent: lastEventOf(payload.status),
    };
  }
}

const lastEventOf = (status: unknown): SentEmailLastEvent =>
  (typeof status === "string" ? LAST_EVENT_BY_STATUS.get(status) : undefined) ?? "unknown";

const senderOf = (message: EmailMessage): string => {
  try {
    return formatMailbox(message.from);
  } catch (error) {
    if (error instanceof EmailHeaderValueError) {
      throw new EmailSendError("rejected", "invalid_header_value");
    }
    throw error;
  }
};

const threadingHeaders = (threading: OutboundThreadingHeaders): Record<string, string> => ({
  "Message-ID": threading.messageId,
  [PRESERVE_MESSAGE_ID_HEADER]: "true",
  ...(threading.inReplyTo ? { "In-Reply-To": threading.inReplyTo } : {}),
  ...(threading.references.length > 0 ? { References: threading.references.join(" ") } : {}),
  ...(threading.autoSubmitted ? { "Auto-Submitted": threading.autoSubmitted } : {}),
});

const messageHeaders = (message: EmailMessage): Record<string, string> | undefined => {
  const threading = message.threading ? threadingHeaders(message.threading) : {};
  if (!message.listUnsubscribeUrl) {
    return Object.keys(threading).length > 0 ? threading : undefined;
  }
  let url: URL;
  try {
    url = new URL(message.listUnsubscribeUrl);
  } catch {
    throw new EmailSendError("rejected", "invalid_header_value");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EmailSendError("rejected", "invalid_header_value");
  }
  return {
    ...threading,
    "List-Unsubscribe": `<${url.toString()}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
};

/** A 2xx is an acceptance even when its body cannot be read; only the provider id is then unknown. */
const isUnreadableAcceptance = (error: unknown): boolean =>
  error instanceof LettermintApiError
  && error.kind === "malformed_response"
  && error.statusCode !== null
  && error.statusCode >= 200
  && error.statusCode < 300;

const messageIdOf = (payload: unknown): string | null =>
  isRecord(payload) && typeof payload.message_id === "string" && payload.message_id.length > 0
    ? payload.message_id
    : null;
