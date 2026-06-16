import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookHttpClient {
  post(request: {
    url: string;
    rawBody: string;
    headers: Record<string, string>;
  }): Promise<void>;
}

export type WebhookUrlGuard = (url: string) => Promise<void>;

const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WEBHOOK_REDIRECTS = 3;

export class FetchWebhookHttpClient implements WebhookHttpClient {
  constructor(
    private readonly assertPublicUrl: WebhookUrlGuard,
    private readonly options: { timeoutMs?: number; maxRedirects?: number; deadlineMs?: number } = {},
  ) {}

  async post(request: { url: string; rawBody: string; headers: Record<string, string> }): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    const deadlineMs = this.options.deadlineMs ?? timeoutMs;
    const maxRedirects = this.options.maxRedirects ?? DEFAULT_MAX_WEBHOOK_REDIRECTS;
    const startedAt = Date.now();
    let currentUrl = request.url;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      await this.assertPublicUrl(currentUrl);
      const remainingMs = deadlineMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new Error(`Webhook exceeded ${deadlineMs}ms delivery deadline`);
      }
      const response = await fetch(currentUrl, {
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
        throw new Error(`Webhook POST failed with status ${response.status}`);
      }
      return;
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
