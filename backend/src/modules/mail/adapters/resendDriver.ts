import { EmailHeaderValueError, formatMailbox, parseRfcMessageId } from "../emailHeaderValues.js";
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
import { ResendApiError, isRecord, type ResendApiClient, type ResendFailureKind } from "./resendApi.js";

/**
 * How a failed Resend call bears on whether the message went out (research A5). A body that
 * differs from the first request under the same idempotency key is a defect on our side, so it
 * is rejected rather than retried.
 */
const FAILURE_CLASSIFICATION: Readonly<
  Record<ResendFailureKind, { outcome: EmailSendOutcome; code: EmailProviderFailureCode }>
> = {
  auth: { outcome: "rejected", code: "auth" },
  not_found: { outcome: "rejected", code: "not_found" },
  rejected: { outcome: "rejected", code: "rejected" },
  idempotency_mismatch: { outcome: "rejected", code: "idempotency_body_mismatch" },
  idempotency_in_flight: { outcome: "retryable", code: "idempotency_in_flight" },
  rate_limited: { outcome: "retryable", code: "rate_limited" },
  unavailable: { outcome: "unknown", code: "unavailable" },
  timeout: { outcome: "unknown", code: "timeout" },
  unreachable: { outcome: "unknown", code: "unreachable" },
  malformed_response: { outcome: "unknown", code: "malformed_response" },
};

/**
 * A failed Resend send. Carries the HTTP status and Resend's error name for delivery logs, but
 * never Resend's error message, which can quote addresses and domains (FR-045).
 */
export class ResendEmailDeliveryError extends EmailSendError {
  readonly statusCode: number | null;
  readonly providerErrorName: string | null;

  constructor(failure: Pick<ResendApiError, "kind" | "statusCode" | "providerErrorName">) {
    const { outcome, code } = FAILURE_CLASSIFICATION[failure.kind];
    super(
      outcome,
      code,
      failure.statusCode === null
        ? `Resend email delivery failed: ${code}`
        : `Resend email delivery failed with status ${failure.statusCode}`,
    );
    this.name = "ResendEmailDeliveryError";
    this.statusCode = failure.statusCode;
    this.providerErrorName = failure.providerErrorName;
  }
}

const SENT_EMAIL_EVENTS: ReadonlySet<string> = new Set<SentEmailLastEvent>([
  "queued",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "failed",
  "suppressed",
]);

export class ResendEmailDriver implements EmailDriver {
  private readonly api: ResendApiClient;

  constructor(options: { api: ResendApiClient }) {
    this.api = options.api;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const body = {
      from: senderOf(message),
      to: message.to,
      reply_to: message.replyTo ?? undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
      tags: message.kind ? [{ name: "kind", value: message.kind }] : undefined,
      headers: message.threading ? threadingHeaders(message.threading) : undefined,
    };
    let payload: unknown;
    try {
      payload = await this.api.request("POST", "/emails", {
        body,
        idempotencyKey: message.idempotencyKey,
      });
    } catch (error) {
      if (isUnreadableAcceptance(error)) {
        return { dispatched: true, providerMessageId: null, deliveredMessageId: null };
      }
      throw error instanceof ResendApiError ? new ResendEmailDeliveryError(error) : error;
    }
    // Resend replaces the supplied Message-ID (research A7), so the delivered id is only known
    // once the message is handed on, through `lookup`.
    return { dispatched: true, providerMessageId: emailIdOf(payload), deliveredMessageId: null };
  }

  async lookup(providerMessageId: string): Promise<SentEmailStatus | null> {
    if (!providerMessageId) {
      return null;
    }
    let payload: unknown;
    try {
      payload = await this.api.request("GET", `/emails/${encodeURIComponent(providerMessageId)}`);
    } catch (error) {
      if (!(error instanceof ResendApiError)) {
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
      // Null while the email is queued; set within seconds once it is sent (research A5).
      deliveredMessageId:
        typeof payload.message_id === "string" ? parseRfcMessageId(payload.message_id) : null,
      lastEvent: isSentEmailEvent(payload.last_event) ? payload.last_event : "unknown",
    };
  }
}

const isSentEmailEvent = (value: unknown): value is SentEmailLastEvent =>
  typeof value === "string" && SENT_EMAIL_EVENTS.has(value);

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
  ...(threading.inReplyTo ? { "In-Reply-To": threading.inReplyTo } : {}),
  ...(threading.references.length > 0 ? { References: threading.references.join(" ") } : {}),
  ...(threading.autoSubmitted ? { "Auto-Submitted": threading.autoSubmitted } : {}),
});

/** A 2xx is an acceptance even when its body cannot be read; only the provider id is then unknown. */
const isUnreadableAcceptance = (error: unknown): boolean =>
  error instanceof ResendApiError
  && error.kind === "malformed_response"
  && error.statusCode !== null
  && error.statusCode >= 200
  && error.statusCode < 300;

const emailIdOf = (payload: unknown): string | null =>
  isRecord(payload) && typeof payload.id === "string" && payload.id.length > 0 ? payload.id : null;
