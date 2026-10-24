/**
 * The one HTTP client the Lettermint adapters use. Lettermint has two credentials for two API
 * surfaces: the project token (`x-lettermint-token`) reaches only the Sending API, the team token
 * (`Authorization: Bearer`) reaches the Team API, which alone reads messages and manages domains
 * and routes. Every call names its surface; a call whose token is not configured fails as `auth`
 * before any request is made. Redirects are never followed.
 *
 * Errors carry only the failure kind, the HTTP status, Lettermint's error code and, for a
 * validation failure, the names of the rejected fields. They never carry a token, Lettermint's
 * error `message` (it can quote addresses and domains), a request body or response content
 * (FR-045).
 */

export type LettermintFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The same vocabulary as Resend's client, so both drivers classify failures alike. */
export type LettermintFailureKind =
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

const RETRYABLE_KINDS: ReadonlySet<LettermintFailureKind> = new Set([
  "rate_limited",
  "idempotency_in_flight",
  "unrecognized_conflict",
  "unavailable",
  "timeout",
  "unreachable",
  "malformed_response",
]);

/** Lettermint answers a token without the needed ability with `403 FORBIDDEN`; other 403s are plan refusals. */
const AUTH_ERROR_CODES: ReadonlySet<string> = new Set(["FORBIDDEN"]);

export class LettermintApiError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: LettermintFailureKind,
    readonly statusCode: number | null,
    readonly providerErrorName: string | null,
    /** The fields a `422` names, for callers that tell one refusal from another by field. */
    readonly fieldNames: readonly string[] = [],
  ) {
    super(
      statusCode === null
        ? `Lettermint request failed: ${kind}`
        : `Lettermint request failed: ${kind} (status ${statusCode})`,
    );
    this.name = "LettermintApiError";
    this.retryable = RETRYABLE_KINDS.has(kind);
  }
}

/** `sending`: the Sending API, with the project token. `team`: the Team API, with the team token. */
type LettermintSurface = "sending" | "team";

type LettermintMethod = "GET" | "POST" | "PUT" | "DELETE";

interface LettermintApiClientOptions {
  projectToken?: string;
  teamToken?: string;
  fetch?: LettermintFetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.lettermint.co/v1";
const DEFAULT_TIMEOUT_MS = 15_000;

export class LettermintApiClient {
  private readonly projectToken: string | null;
  private readonly teamToken: string | null;
  private readonly fetchImpl: LettermintFetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: LettermintApiClientOptions) {
    this.projectToken = options.projectToken?.trim() || null;
    this.teamToken = options.teamToken?.trim() || null;
    if (!this.projectToken && !this.teamToken) {
      throw new Error("A Lettermint project or team token is required");
    }
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Calls the API and returns the parsed JSON body. Throws `LettermintApiError`. */
  async request(
    surface: LettermintSurface,
    method: LettermintMethod,
    path: string,
    options: { body?: unknown; idempotencyKey?: string | null } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json", ...this.authHeader(surface) };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    const response = await this.send(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      throw await failureFrom(response);
    }
    return readJson(response);
  }

  /** Reads a Team API resource that is not JSON, such as a message's raw RFC 5322 source. Throws `LettermintApiError`. */
  async requestBytes(path: string): Promise<Buffer> {
    const response = await this.send(path, { method: "GET", headers: this.authHeader("team") });
    if (!response.ok) {
      throw await failureFrom(response);
    }
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw transportFailure(error);
    }
  }

  private authHeader(surface: LettermintSurface): Record<string, string> {
    if (surface === "team") {
      if (!this.teamToken) throw new LettermintApiError("auth", null, null);
      return { Authorization: `Bearer ${this.teamToken}` };
    }
    if (!this.projectToken) throw new LettermintApiError("auth", null, null);
    return { "x-lettermint-token": this.projectToken };
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw transportFailure(error);
    }
    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      throw new LettermintApiError("malformed_response", response.status, null);
    }
    return response;
  }
}

const kindForStatus = (status: number, code: string | null): LettermintFailureKind => {
  if (status === 401) return "auth";
  if (status === 403 && code !== null && AUTH_ERROR_CODES.has(code)) return "auth";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 409 && code === "concurrent_idempotent_requests") return "idempotency_in_flight";
  if (status === 409 && code === "invalid_idempotent_request") return "idempotency_mismatch";
  // Lettermint documents both idempotency conflicts with a body that carries only a message, so
  // a 409 naming no known code may still be an earlier request under the same key in progress;
  // calling it a rejection would end reconciliation of a send that can still go out.
  if (status === 409) return "unrecognized_conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "rejected";
};

const transportFailure = (error: unknown): LettermintApiError =>
  new LettermintApiError(isTimeout(error) ? "timeout" : "unreachable", null, null);

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

const failureFrom = async (response: Response): Promise<LettermintApiError> => {
  const { code, fieldNames } = await readErrorBody(response);
  return new LettermintApiError(kindForStatus(response.status, code), response.status, code, fieldNames);
};

/** Error codes and field names are identifiers; anything else is dropped rather than echoed. */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Lettermint's two error shapes: `{error: {code, message}}`, and `{message}` with `errors` for a
 * validation failure. Only the code and the field names are read.
 */
const readErrorBody = async (response: Response): Promise<{ code: string | null; fieldNames: string[] }> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch {
    return { code: null, fieldNames: [] };
  }
  if (!isRecord(parsed)) {
    return { code: null, fieldNames: [] };
  }
  const error = parsed.error;
  const code = isRecord(error) ? error.code : error;
  return {
    code: typeof code === "string" && ERROR_CODE.test(code) ? code : null,
    fieldNames: isRecord(parsed.errors) ? Object.keys(parsed.errors).filter((name) => FIELD_NAME.test(name)) : [],
  };
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
    throw new LettermintApiError("malformed_response", response.status, null);
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
