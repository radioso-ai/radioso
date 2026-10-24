import {
  InboundFetchError,
  type AuthVerdict,
  type InboundEmailMessage,
  type InboundEmailReceiver,
  type InboundVerification,
} from "../inboundEmailReceiver.js";
import { normalizeInboundMime, type InboundProviderFacts } from "../inboundMimeNormalizer.js";
import {
  LettermintApiError,
  isRecord,
  type LettermintApiClient,
  type LettermintFailureKind,
} from "./lettermintApi.js";
import { LettermintWebhookVerifier } from "./lettermintWebhook.js";
import type { WebhookSigningSecrets } from "./resendWebhook.js";

/**
 * Lettermint inbound routes. The `message.inbound` webhook is only a notice here: content is read
 * with the team token from the message record (`GET /messages/{id}`) and its raw RFC 5322 source
 * (`GET /messages/{id}/source`), both kept for 28 days. The raw source is the source of every
 * message field and of the authentication results; the record contributes only its recipients.
 */

interface LettermintInboundReceiverOptions {
  api: LettermintApiClient;
  signingSecrets: WebhookSigningSecrets;
}

export class LettermintInboundEmailReceiver implements InboundEmailReceiver {
  readonly provider = "lettermint";
  private readonly api: LettermintApiClient;
  private readonly verifier: LettermintWebhookVerifier;

  constructor(options: LettermintInboundReceiverOptions) {
    this.api = options.api;
    this.verifier = new LettermintWebhookVerifier(options.signingSecrets);
  }

  verify(request: Parameters<InboundEmailReceiver["verify"]>[0]): InboundVerification {
    return this.verifier.verify(request);
  }

  async fetchMessage(providerObjectId: string): Promise<InboundEmailMessage> {
    const path = `/messages/${encodeURIComponent(providerObjectId)}`;
    const record = await this.readRecord(path);
    const raw = await this.readSource(`${path}/source`);
    return normalizeInboundMime(raw, providerFactsOf(record, raw));
  }

  private async readRecord(path: string): Promise<Record<string, unknown>> {
    let payload: unknown;
    try {
      payload = await this.api.request("team", "GET", path);
    } catch (error) {
      throw fetchError(error);
    }
    if (!isRecord(payload)) {
      throw new InboundFetchError(true, "malformed_provider_response");
    }
    return payload;
  }

  private async readSource(path: string): Promise<Buffer> {
    let raw: Buffer;
    try {
      raw = await this.api.requestBytes(path);
    } catch (error) {
      // 410: the content retention window has passed, so no later attempt can read it.
      if (error instanceof LettermintApiError && error.statusCode === 410) {
        throw new InboundFetchError(false, "raw_expired");
      }
      throw fetchError(error);
    }
    if (raw.length === 0) {
      throw new InboundFetchError(true, "raw_unavailable");
    }
    return raw;
  }
}

const FAILURE_CODES: Readonly<Record<LettermintFailureKind, string>> = {
  auth: "provider_auth_failed",
  not_found: "message_not_found",
  rate_limited: "provider_rate_limited",
  idempotency_mismatch: "provider_rejected",
  idempotency_in_flight: "provider_rate_limited",
  unrecognized_conflict: "provider_unavailable",
  rejected: "provider_rejected",
  unavailable: "provider_unavailable",
  timeout: "provider_timeout",
  unreachable: "provider_unreachable",
  malformed_response: "malformed_provider_response",
};

const fetchError = (error: unknown): InboundFetchError =>
  error instanceof LettermintApiError
    ? new InboundFetchError(error.retryable, FAILURE_CODES[error.kind])
    : new InboundFetchError(true, "provider_unreachable");

/**
 * The inbound route's spam threshold is the spam filter: Lettermint quarantines mail at or above it
 * and sends no webhook for it, and mail released from quarantine was released by a person. Radioso
 * judges neither again, so the verdict is `unknown`, which classification treats as not spam
 * (FR-015).
 */
const providerFactsOf = (record: Record<string, unknown>, raw: Buffer): InboundProviderFacts => ({
  receivedFor: [record.to, record.cc, record.bcc].flatMap(recipientAddresses),
  authentication: authenticationOf(raw),
  spamVerdict: "unknown",
});

const recipientAddresses = (recipients: unknown): string[] =>
  Array.isArray(recipients)
    ? recipients.flatMap((recipient: unknown) =>
        isRecord(recipient) && typeof recipient.email === "string" && recipient.email.trim() ? [recipient.email.trim()] : [])
    : [];

/** The authserv-id Lettermint's receiving servers stamp on the `Authentication-Results` they add. */
const LETTERMINT_AUTHSERV_ID = "lettermint.mx";

/**
 * RFC 8601 results onto the port's verdicts. Only `pass` passes; a result that names a failure,
 * a soft failure or a local policy refusal fails; `neutral` and `none` assert nothing (`gray`);
 * an evaluation error is `processing_failed`; anything else is `unknown`.
 */
const VERDICT_BY_RESULT: ReadonlyMap<string, AuthVerdict> = new Map([
  ["pass", "pass"],
  ["fail", "fail"],
  ["softfail", "fail"],
  ["policy", "fail"],
  ["neutral", "gray"],
  ["none", "gray"],
  ["temperror", "processing_failed"],
  ["permerror", "processing_failed"],
]);

/**
 * Read from the topmost `Authentication-Results` header, and only when its authserv-id is
 * Lettermint's. Lettermint adds it on receipt above every header the message arrived with, so any
 * instance further down, even one naming `lettermint.mx`, was written upstream or by the sender and
 * is not trusted. A topmost header from anyone else means Lettermint added none: every verdict is
 * then `unknown`.
 */
const authenticationOf = (raw: Buffer): InboundEmailMessage["authentication"] => {
  const [topmost] = topLevelHeaderValues(raw, "authentication-results");
  const parsed = topmost === undefined ? null : parseAuthenticationResults(topmost);
  const results = parsed?.authservId === LETTERMINT_AUTHSERV_ID ? parsed : undefined;
  return {
    spf: methodVerdict(results?.methods.get("spf")),
    dkim: methodVerdict(results?.methods.get("dkim")),
    dmarc: methodVerdict(results?.methods.get("dmarc")),
  };
};

/** A method passes when any of its results passed, such as one valid DKIM signature among several. */
const methodVerdict = (results: readonly string[] | undefined): AuthVerdict => {
  if (!results || results.length === 0) {
    return "unknown";
  }
  return results.includes("pass") ? "pass" : (VERDICT_BY_RESULT.get(results[0] ?? "") ?? "unknown");
};

/** The unfolded values of one header field in the message's own header block, in order. */
const topLevelHeaderValues = (raw: Buffer, lowerCaseName: string): string[] => {
  const text = raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const block = end < 0 ? text : text.slice(0, end);
  const prefix = `${lowerCaseName}:`;
  return block
    .replace(/\r?\n(?=[ \t])/g, "")
    .split(/\r?\n/)
    .filter((line) => line.slice(0, prefix.length).toLowerCase() === prefix)
    .map((line) => line.slice(prefix.length));
};

interface AuthenticationResults {
  authservId: string;
  /** Each method's results in header order, lower-cased. */
  methods: ReadonlyMap<string, readonly string[]>;
}

/** RFC 8601 `method[/version] = result`; the rest of a resinfo (reason, properties) is not read. */
const METHOD_RESULT = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*(?:\/\s*\d+\s*)?=\s*([A-Za-z0-9_-]+)/;

const parseAuthenticationResults = (value: string): AuthenticationResults | null => {
  const [authserv = "", ...resinfos] = resinfoSegments(value);
  const authservId = authserv.split(/\s+/)[0]?.toLowerCase();
  if (!authservId) {
    return null;
  }
  const methods = new Map<string, string[]>();
  for (const resinfo of resinfos) {
    const match = METHOD_RESULT.exec(resinfo);
    if (match?.[1] && match[2]) {
      const method = match[1].toLowerCase();
      methods.set(method, [...(methods.get(method) ?? []), match[2].toLowerCase()]);
    }
  }
  return { authservId, methods };
};

/** Splits a header value on its top-level `;`, dropping RFC 5322 comments and keeping quoted strings whole. */
const resinfoSegments = (value: string): string[] => {
  const segments: string[] = [];
  let current = "";
  let commentDepth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === "\\" && (quoted || commentDepth > 0)) {
      if (quoted) current += value.slice(index, index + 2);
      index += 1;
    } else if (quoted) {
      current += char;
      quoted = char !== '"';
    } else if (commentDepth > 0) {
      commentDepth += char === "(" ? 1 : char === ")" ? -1 : 0;
    } else if (char === "(") {
      commentDepth = 1;
      current += " ";
    } else if (char === ";") {
      segments.push(current.trim());
      current = "";
    } else {
      quoted = char === '"';
      current += char;
    }
  }
  segments.push(current.trim());
  return segments;
};
