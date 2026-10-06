/**
 * The one HTTP client the email-channel adapters use to reach Resend: base URL, bearer auth, a
 * per-request timeout, and the classification of every failure as retryable or not.
 *
 * Errors carry only the failure kind, the HTTP status and Resend's error name. They never carry
 * the API key, Resend's error `message` (it can quote addresses and domains), a request body or
 * response content (FR-045).
 */

export type ResendFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ResendFailureKind =
  | "auth"
  | "not_found"
  | "rate_limited"
  | "idempotency_mismatch"
  | "idempotency_in_flight"
  | "unrecognized_conflict"
  | "rejected"
  | "unavailable"
  | "timeout"
  | "unreachable"
  | "malformed_response";

const RETRYABLE_KINDS: ReadonlySet<ResendFailureKind> = new Set([
  "rate_limited",
  "idempotency_in_flight",
  "unrecognized_conflict",
  "unavailable",
  "timeout",
  "unreachable",
  "malformed_response",
]);

/** Resend reports a bad, missing or under-privileged key as 401 or 403 with one of these names. */
const AUTH_ERROR_NAMES: ReadonlySet<string> = new Set([
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
]);

export class ResendApiError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: ResendFailureKind,
    readonly statusCode: number | null,
    readonly providerErrorName: string | null,
  ) {
    super(
      statusCode === null
        ? `Resend request failed: ${kind}`
        : `Resend request failed: ${kind} (status ${statusCode})`,
    );
    this.name = "ResendApiError";
    this.retryable = RETRYABLE_KINDS.has(kind);
  }
}

type ResendMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface ResendApiClientOptions {
  apiKey: string;
  fetch?: ResendFetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 15_000;

export class ResendApiClient {
  private readonly apiKey: string;
  private readonly fetchImpl: ResendFetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ResendApiClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("A Resend API key is required");
    }
    this.apiKey = apiKey;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Calls the API and returns the parsed JSON body. Throws `ResendApiError`. */
  async request(
    method: ResendMethod,
    path: string,
    options: { body?: unknown; idempotencyKey?: string | null } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    const response = await this.send(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      throw await failureFrom(response);
    }
    return readJson(response);
  }

  /**
   * Downloads a signed provider URL, such as a received message's raw MIME. The URL carries its
   * own authorization, so the API key is never sent to it. Throws `ResendApiError`.
   */
  async download(url: string): Promise<Buffer> {
    const response = await this.send(url, { method: "GET" });
    if (!response.ok) {
      await discardBody(response);
      throw new ResendApiError(kindForStatus(response.status, null), response.status, null);
    }
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw transportFailure(error);
    }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw transportFailure(error);
    }
  }
}

const kindForStatus = (status: number, providerErrorName: string | null): ResendFailureKind => {
  if (status === 401) return "auth";
  if (status === 403 && providerErrorName !== null && AUTH_ERROR_NAMES.has(providerErrorName)) return "auth";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 409 && providerErrorName === "concurrent_idempotent_requests") return "idempotency_in_flight";
  if (status === 409 && providerErrorName === "invalid_idempotent_request") return "idempotency_mismatch";
  // A conflict whose body is unreadable or names nothing we know may still be an earlier request
  // under the same key in progress; calling it a rejection would end reconciliation of a send
  // that can still go out.
  if (status === 409) return "unrecognized_conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "rejected";
};

const transportFailure = (error: unknown): ResendApiError =>
  new ResendApiError(isTimeout(error) ? "timeout" : "unreachable", null, null);

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

const failureFrom = async (response: Response): Promise<ResendApiError> => {
  const providerErrorName = await readProviderErrorName(response);
  return new ResendApiError(
    kindForStatus(response.status, providerErrorName),
    response.status,
    providerErrorName,
  );
};

/** Resend error names are snake_case identifiers; anything else is dropped rather than echoed. */
const PROVIDER_ERROR_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const readProviderErrorName = async (response: Response): Promise<string | null> => {
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed) && typeof parsed.name === "string" && PROVIDER_ERROR_NAME.test(parsed.name)) {
      return parsed.name;
    }
  } catch {
    return null;
  }
  return null;
};

const readJson = async (response: Response): Promise<unknown> => {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw transportFailure(error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ResendApiError("malformed_response", response.status, null);
  }
};

const discardBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
