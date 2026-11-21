import { assertPublicHttpUrl, isLocalDevelopmentHttpUrl } from "../../domain/publicNetwork.js";
import { discardBody, isPublicNetworkRefusal, readCappedBody, resolveRedirectLocation } from "./publicBytesFetch.js";
import { fetchPublicUrl } from "./publicUrlFetch.js";

export const publicHttpRequestMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type PublicHttpRequestMethod = (typeof publicHttpRequestMethods)[number];

export interface PublicHttpRequest {
  readonly method: PublicHttpRequestMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent as it is; the caller names its content type in `headers`. */
  readonly body?: string;
}

/** How far one request may go: in time, in response bytes, and in redirects. */
export interface PublicHttpRequestLimits {
  /** One budget for every hop and the whole response body together. */
  readonly timeoutMs: number;
  /** The response body is read up to this many bytes and no further, whatever it declared. */
  readonly maxResponseBytes: number;
  /** Same-origin redirects a GET follows. Three when unset; any other method follows none. */
  readonly maxRedirects?: number;
  /** The caller's own cancellation, on top of `timeoutMs`; its abort ends the request as a timeout. */
  readonly signal?: AbortSignal;
}

/** What reaches the network. Each defaults to the public policy; a test or a local setup may widen it. */
interface PublicHttpRequestTransport {
  /** Sends one hop. `fetchPublicUrl` checks every connection resolves to a public address. */
  readonly fetch?: typeof fetch;
  /** Checks the first URL and every redirect target before it is requested; throws when it is refused. */
  readonly assertUrl?: (url: string) => URL;
  /** Plain http to this machine goes out without the public policy (local development, e2e; never production). */
  readonly allowHttpLoopback?: boolean;
}

/**
 * Why no answer came back. `blocked` is a URL the policy refuses or a name that resolves to a
 * private address; `redirect_refused` is a redirect to another origin, or any redirect of a
 * request that is not a GET; `unreachable` is any other network failure.
 */
export type PublicHttpRequestFailure =
  | "blocked"
  | "timeout"
  | "too_large"
  | "redirect_refused"
  | "too_many_redirects"
  | "unreachable";

export type PublicHttpRequestResult =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: Buffer;
      readonly contentType: string | null;
      readonly durationMs: number;
    }
  | {
      readonly kind: "failed";
      readonly reason: PublicHttpRequestFailure;
      readonly status?: number;
      readonly durationMs: number;
    };

const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Sends one HTTP request to a public host and reads its answer within bounds: a deadline over every
 * hop and the body, a byte cap enforced on the stream, and redirects followed only by a GET, only
 * within the origin it started on, each target re-checked before it is requested. Any status comes
 * back as a response with its body; a failure comes back as a reason, never as a thrown error or a
 * partial body. It knows HTTP and the egress policy, and nothing about who is calling or why.
 */
export const sendPublicHttpRequest = async (
  request: PublicHttpRequest,
  limits: PublicHttpRequestLimits,
  transport: PublicHttpRequestTransport = {},
): Promise<PublicHttpRequestResult> => {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);
  const failed = (reason: PublicHttpRequestFailure, status?: number): PublicHttpRequestResult => ({
    kind: "failed",
    reason,
    ...(status === undefined ? {} : { status }),
    durationMs: elapsed(),
  });
  const maxRedirects = request.method === "GET" ? limits.maxRedirects ?? DEFAULT_MAX_REDIRECTS : 0;
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = limits.signal ? AbortSignal.any([timeout, limits.signal]) : timeout;
  try {
    let current = request.url;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await sendHop(request, current, signal, transport);
      if (!REDIRECT_STATUSES.has(response.status)) {
        return await readResponse(response, limits.maxResponseBytes, elapsed);
      }
      const location = response.headers.get("location");
      await discardBody(response);
      if (!location) {
        return { kind: "response", status: response.status, body: Buffer.alloc(0), contentType: null, durationMs: elapsed() };
      }
      const next = resolveRedirectLocation(location, new URL(current));
      if (request.method !== "GET" || !sameOrigin(next, current)) {
        return failed("redirect_refused", response.status);
      }
      current = next;
    }
    return failed("too_many_redirects");
  } catch (error) {
    if (signal.aborted) return failed("timeout");
    return failed(isPublicNetworkRefusal(error) ? "blocked" : "unreachable");
  }
};

const sendHop = (
  request: PublicHttpRequest,
  url: string,
  signal: AbortSignal,
  transport: PublicHttpRequestTransport,
): Promise<Response> => {
  const loopback = transport.allowHttpLoopback === true && isLocalDevelopmentHttpUrl(url);
  if (!loopback) {
    (transport.assertUrl ?? assertPublicHttpUrl)(url);
  }
  const send = loopback ? globalThis.fetch : transport.fetch ?? fetchPublicUrl;
  return send(url, {
    method: request.method,
    headers: { ...request.headers },
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "manual",
    signal,
  });
};

const readResponse = async (
  response: Response,
  maxBytes: number,
  elapsed: () => number,
): Promise<PublicHttpRequestResult> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    return { kind: "failed", reason: "too_large", status: response.status, durationMs: elapsed() };
  }
  const body = await readCappedBody(response, maxBytes);
  if (!body) {
    return { kind: "failed", reason: "too_large", status: response.status, durationMs: elapsed() };
  }
  return {
    kind: "response",
    status: response.status,
    body,
    contentType: response.headers.get("content-type"),
    durationMs: elapsed(),
  };
};

const sameOrigin = (next: string, current: string): boolean => {
  try {
    return new URL(next).origin === new URL(current).origin;
  } catch {
    return false;
  }
};
