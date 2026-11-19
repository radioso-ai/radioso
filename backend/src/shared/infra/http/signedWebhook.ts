import { createHmac, timingSafeEqual } from "node:crypto";

import { fetchPublicUrl } from "./publicUrlFetch.js";

export interface WebhookHttpClient {
  /** Resolves once the target accepted the body; an implementation may report the accepting status. */
  post(request: {
    url: string;
    rawBody: string;
    headers: Record<string, string>;
  }): Promise<{ status: number } | void>;
}

export type WebhookUrlGuard = (url: string) => Promise<void>;

/** A target that answered outside 2xx (after redirects). Carries the status only, never the body. */
export class WebhookResponseStatusError extends Error {
  constructor(readonly status: number) {
    super(`Webhook POST failed with status ${status}`);
    this.name = "WebhookResponseStatusError";
  }
}

/** Why a webhook target URL was refused before any host lookup: not a URL, or not https. */
export class WebhookTargetUrlError extends Error {
  constructor(readonly problem: "invalid" | "not_https") {
    super(problem === "invalid" ? "Webhook target URL must be valid" : "Webhook target URL must use https");
    this.name = "WebhookTargetUrlError";
  }
}

const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WEBHOOK_REDIRECTS = 3;

/** Plain http to this machine: a target only where `allowHttpLoopback` is set (local development, e2e). */
const isLocalDevelopmentHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") {
      return false;
    }
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "host.docker.internal" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
};

/**
 * The rule a signed-webhook target meets when it is saved: a URL over https whose host resolves to
 * a public address, or plain http to this machine where `allowHttpLoopback` is set. Returns the URL
 * with its scheme lower-cased. A malformed or non-https URL throws {@link WebhookTargetUrlError}; a
 * host that is not public throws whatever `assertPublicUrl` throws. Delivery checks every hop again.
 */
export const normalizeWebhookTargetUrl = async (
  value: string,
  options: { assertPublicUrl: WebhookUrlGuard; allowHttpLoopback?: boolean },
): Promise<string> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookTargetUrlError("invalid");
  }
  const normalized = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/u, url.protocol);
  if (url.protocol === "http:" && options.allowHttpLoopback === true && isLocalDevelopmentHttpUrl(value)) {
    return normalized;
  }
  if (url.protocol !== "https:") {
    throw new WebhookTargetUrlError("not_https");
  }
  await options.assertPublicUrl(normalized);
  return normalized;
};

export class FetchWebhookHttpClient implements WebhookHttpClient {
  constructor(
    private readonly assertPublicUrl: WebhookUrlGuard,
    private readonly options: {
      timeoutMs?: number;
      maxRedirects?: number;
      deadlineMs?: number;
      allowHttpLoopback?: boolean;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  /** Resolves with the accepting response's status; a refused hop, a timeout or a non-2xx answer throws. */
  async post(request: { url: string; rawBody: string; headers: Record<string, string> }): Promise<{ status: number }> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    const deadlineMs = this.options.deadlineMs ?? timeoutMs;
    const maxRedirects = this.options.maxRedirects ?? DEFAULT_MAX_WEBHOOK_REDIRECTS;
    const startedAt = Date.now();
    let currentUrl = request.url;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (!(this.options.allowHttpLoopback === true && isLocalDevelopmentHttpUrl(currentUrl))) {
        await this.assertPublicUrl(currentUrl);
      }
      const remainingMs = deadlineMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new Error(`Webhook exceeded ${deadlineMs}ms delivery deadline`);
      }
      const fetchImpl = this.options.allowHttpLoopback === true && isLocalDevelopmentHttpUrl(currentUrl)
        ? fetch
        : (this.options.fetchImpl ?? fetchPublicUrl);
      const response = await fetchImpl(currentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...request.headers },
        body: request.rawBody,
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(timeoutMs, remainingMs)),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Webhook redirect (${response.status}) had no location`);
        }
        const previousUrl = new URL(currentUrl);
        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.origin !== previousUrl.origin) {
          throw new Error("Webhook redirect changed origin");
        }
        currentUrl = nextUrl.toString();
        continue;
      }
      if (!response.ok) {
        throw new WebhookResponseStatusError(response.status);
      }
      return { status: response.status };
    }
    throw new Error(`Webhook exceeded ${maxRedirects} redirects`);
  }
}

const signaturePayload = (timestamp: string, rawBody: string): string =>
  `${timestamp}.${rawBody}`;

const signatureDigest = (input: { rawBody: string; secret: string; timestamp: string }): string =>
  createHmac("sha256", input.secret)
    .update(signaturePayload(input.timestamp, input.rawBody))
    .digest("hex");

export const createSignedWebhookHeaders = (input: {
  rawBody: string;
  secret: string;
  idempotencyKey: string;
  timestamp?: string;
}): Record<string, string> => {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const digest = signatureDigest({ rawBody: input.rawBody, secret: input.secret, timestamp });
  return {
    "Idempotency-Key": input.idempotencyKey,
    "X-Radioso-Timestamp": timestamp,
    "X-Radioso-Signature": `sha256=${digest}`,
  };
};

export const verifyWebhookSignature = (input: {
  rawBody: string;
  secret: string;
  timestamp: string;
  signatureHeader: string | null | undefined;
}): boolean => {
  const signature = input.signatureHeader?.startsWith("sha256=")
    ? input.signatureHeader.slice("sha256=".length)
    : "";
  if (!/^[a-f0-9]{64}$/iu.test(signature)) {
    return false;
  }
  const expected = Buffer.from(signatureDigest(input), "hex");
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
