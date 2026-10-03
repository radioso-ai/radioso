import {
  InboundFetchError,
  type AuthVerdict,
  type InboundEmailMessage,
  type InboundEmailReceiver,
  type InboundVerification,
} from "../inboundEmailReceiver.js";
import { normalizeInboundMime, type InboundProviderFacts } from "../inboundMimeNormalizer.js";
import { ResendApiError, isRecord, type ResendApiClient, type ResendFailureKind } from "./resendApi.js";
import { ResendWebhookVerifier, type WebhookSigningSecrets } from "./resendWebhook.js";

/**
 * Resend Receiving. The `email.received` webhook carries metadata only, so content is fetched in
 * two steps: the received-email record (`GET /emails/receiving/{id}`), then its raw MIME from the
 * record's signed download URL. Every attempt re-reads the record because the URL expires after
 * about an hour. The MIME itself is the source of every message field; the record contributes
 * only what the provider alone knows: `received_for`, authentication results and the SES spam
 * verdict.
 */

interface ResendInboundReceiverOptions {
  api: ResendApiClient;
  signingSecrets: WebhookSigningSecrets;
}

export class ResendInboundEmailReceiver implements InboundEmailReceiver {
  readonly provider = "resend";
  private readonly api: ResendApiClient;
  private readonly verifier: ResendWebhookVerifier;

  constructor(options: ResendInboundReceiverOptions) {
    this.api = options.api;
    this.verifier = new ResendWebhookVerifier(options.signingSecrets);
  }

  verify(request: Parameters<InboundEmailReceiver["verify"]>[0]): InboundVerification {
    return this.verifier.verify(request);
  }

  async fetchMessage(providerObjectId: string): Promise<InboundEmailMessage> {
    const record = await this.readReceivedEmail(providerObjectId);
    const downloadUrl = rawDownloadUrlOf(record);
    if (!downloadUrl) {
      throw new InboundFetchError(true, "raw_unavailable");
    }
    const raw = await this.downloadRaw(downloadUrl);
    return normalizeInboundMime(raw, providerFactsOf(record));
  }

  private async readReceivedEmail(providerObjectId: string): Promise<Record<string, unknown>> {
    let payload: unknown;
    try {
      payload = await this.api.request("GET", `/emails/receiving/${encodeURIComponent(providerObjectId)}`);
    } catch (error) {
      throw recordFetchError(error);
    }
    if (!isRecord(payload)) {
      throw new InboundFetchError(true, "malformed_provider_response");
    }
    return payload;
  }

  private async downloadRaw(url: string): Promise<Buffer> {
    try {
      return await this.api.download(url);
    } catch (error) {
      throw downloadFetchError(error);
    }
  }
}

const RECORD_FAILURE_CODES: Readonly<Record<ResendFailureKind, string>> = {
  auth: "provider_auth_failed",
  not_found: "message_not_found",
  rate_limited: "provider_rate_limited",
  idempotency_mismatch: "provider_rejected",
  idempotency_in_flight: "provider_rate_limited",
  rejected: "provider_rejected",
  unavailable: "provider_unavailable",
  timeout: "provider_timeout",
  unreachable: "provider_unreachable",
  malformed_response: "malformed_provider_response",
};

const recordFetchError = (error: unknown): InboundFetchError =>
  error instanceof ResendApiError
    ? new InboundFetchError(error.retryable, RECORD_FAILURE_CODES[error.kind])
    : new InboundFetchError(true, "provider_unreachable");

/** A failed raw download is retried whatever its status: the next attempt reads a fresh URL. */
const downloadFetchError = (error: unknown): InboundFetchError =>
  error instanceof ResendApiError && (error.kind === "timeout" || error.kind === "unreachable")
    ? new InboundFetchError(true, RECORD_FAILURE_CODES[error.kind])
    : new InboundFetchError(true, "raw_download_failed");

const rawDownloadUrlOf = (record: Record<string, unknown>): string | null => {
  const raw = record.raw;
  if (!isRecord(raw) || typeof raw.download_url !== "string") {
    return null;
  }
  try {
    return new URL(raw.download_url).protocol === "https:" ? raw.download_url : null;
  } catch {
    return null;
  }
};

const providerFactsOf = (record: Record<string, unknown>): InboundProviderFacts => ({
  receivedFor: Array.isArray(record.received_for)
    ? record.received_for.filter((value): value is string => typeof value === "string")
    : [],
  authentication: authenticationOf(record.authentication),
  spamVerdict: spamVerdictOf(record.headers),
});

const AUTH_VERDICTS: ReadonlySet<string> = new Set<AuthVerdict>([
  "pass",
  "fail",
  "gray",
  "processing_failed",
  "unknown",
]);

const isAuthVerdict = (value: unknown): value is AuthVerdict =>
  typeof value === "string" && AUTH_VERDICTS.has(value);

const authVerdictOf = (value: unknown): AuthVerdict => (isAuthVerdict(value) ? value : "unknown");

const authenticationOf = (value: unknown): InboundEmailMessage["authentication"] => {
  const results = isRecord(value) ? value : {};
  return {
    spf: authVerdictOf(results.spf),
    dkim: authVerdictOf(results.dkim),
    dmarc: authVerdictOf(results.dmarc),
  };
};

/**
 * Resend receives through Amazon SES, which stamps `X-SES-Spam-Verdict` with PASS, FAIL, GRAY
 * or PROCESSING_FAILED. Only PASS and FAIL are a verdict; the rest is `unknown`, which
 * classification treats as not spam (FR-015).
 */
const spamVerdictOf = (headers: unknown): InboundEmailMessage["spamVerdict"] => {
  const verdict = isRecord(headers) ? headers["x-ses-spam-verdict"] : undefined;
  if (typeof verdict !== "string") {
    return "unknown";
  }
  switch (verdict.trim().toUpperCase()) {
    case "PASS":
      return "not_spam";
    case "FAIL":
      return "spam";
    default:
      return "unknown";
  }
};
