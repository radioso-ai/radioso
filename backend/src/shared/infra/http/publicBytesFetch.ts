import { assertPublicHttpUrl, PublicNetworkPolicyError } from "../../domain/publicNetwork.js";
import { fetchPublicUrl } from "./publicUrlFetch.js";

/** How far one fetch may go: in time, in bytes, in redirects, and what it must turn out to be. */
export interface PublicBytesLimits {
  /** One budget for every hop and the whole body together. */
  readonly timeoutMs: number;
  /** The body is read up to this many bytes and no further, whatever the response declared. */
  readonly maxBytes: number;
  /** When set, a response whose content type does not start with it (such as `image/`) is not read. */
  readonly contentTypePrefix?: string;
  /** Sent as the `Accept` header, such as `image/*`. */
  readonly accept?: string;
  /** Redirects followed, each re-checked before it is requested. Three when unset. */
  readonly maxRedirects?: number;
  /** The caller's own deadline or cancellation, on top of `timeoutMs`; its abort ends the fetch as a timeout. */
  readonly signal?: AbortSignal;
}

/** What reaches the network. Both default to the public policy; a test or a local setup may widen them. */
interface PublicBytesTransport {
  /** Requests one URL. `fetchPublicUrl` checks every connection resolves to a public address. */
  readonly fetch?: typeof fetch;
  /** Checks the first URL and every redirect target before it is requested; throws when it is refused. */
  readonly assertUrl?: (url: string) => URL;
}

/**
 * Why no bytes came back. `blocked` is a URL or a redirect target the policy refuses, or a name
 * that resolves to a private address; `unreachable` is any other network failure.
 */
export type PublicBytesFetchFailure =
  | "blocked"
  | "timeout"
  | "too_large"
  | "http_status"
  | "content_type"
  | "too_many_redirects"
  | "unreachable";

export type PublicBytesFetchResult =
  | { readonly kind: "fetched"; readonly bytes: Buffer; readonly contentType: string | null; readonly url: string }
  | { readonly kind: "failed"; readonly reason: PublicBytesFetchFailure; readonly status?: number };

const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const failed = (reason: PublicBytesFetchFailure, status?: number): PublicBytesFetchResult =>
  status === undefined ? { kind: "failed", reason } : { kind: "failed", reason, status };

/**
 * Fetches one public URL's bytes with bounds `fetchPublicUrl` does not set: a time budget, a byte
 * cap enforced on the stream, an optional content-type check, and redirects followed one at a time
 * so each target is re-checked before it is requested. A failure comes back as a reason, never as
 * a thrown error or a partial body. Callers that do not opt in keep `fetchPublicUrl` as it is.
 */
export const fetchPublicBytes = async (
  url: string,
  limits: PublicBytesLimits,
  transport: PublicBytesTransport = {},
): Promise<PublicBytesFetchResult> => {
  const request = transport.fetch ?? fetchPublicUrl;
  const assertUrl = transport.assertUrl ?? assertPublicHttpUrl;
  const maxRedirects = limits.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = limits.signal ? AbortSignal.any([timeout, limits.signal]) : timeout;
  try {
    let current = assertUrl(url);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await request(current.toString(), {
        method: "GET",
        headers: limits.accept ? { accept: limits.accept } : {},
        redirect: "manual",
        signal,
      });
      if (!REDIRECT_STATUSES.has(response.status)) return await readBounded(response, current, limits);
      const location = response.headers.get("location");
      await discard(response);
      if (!location) return failed("http_status", response.status);
      current = assertUrl(resolveLocation(location, current));
    }
    return failed("too_many_redirects");
  } catch (error) {
    if (signal.aborted) return failed("timeout");
    return failed(isPolicyRefusal(error) ? "blocked" : "unreachable");
  }
};

const readBounded = async (response: Response, url: URL, limits: PublicBytesLimits): Promise<PublicBytesFetchResult> => {
  if (!response.ok) {
    await discard(response);
    return failed("http_status", response.status);
  }
  const contentType = response.headers.get("content-type");
  if (limits.contentTypePrefix !== undefined && !(contentType ?? "").trim().toLowerCase().startsWith(limits.contentTypePrefix.toLowerCase())) {
    await discard(response);
    return failed("content_type");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limits.maxBytes) {
    await discard(response);
    return failed("too_large");
  }
  const bytes = await readCapped(response, limits.maxBytes);
  return bytes ? { kind: "fetched", bytes, contentType, url: url.toString() } : failed("too_large");
};

/** Reads the body up to the cap and no further: a body that outgrows it is cut off and `null` comes back. */
const readCapped = async (response: Response, maxBytes: number): Promise<Buffer | null> => {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
};

const discard = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

/** A relative Location resolves against the URL that sent it; one that does not parse goes to the policy as it is, to be refused. */
const resolveLocation = (location: string, base: URL): string => {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
};

/** The transport wraps a refused connection in its own error; the policy's error is somewhere in the cause chain. */
const isPolicyRefusal = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof PublicNetworkPolicyError) return true;
    current = current.cause;
  }
  return false;
};
