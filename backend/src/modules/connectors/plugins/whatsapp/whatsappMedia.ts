import { PublicNetworkPolicyError } from "../../../../shared/domain/publicNetwork.js";
import { WHATSAPP_GRAPH_BASE_URL, WhatsAppClientError } from "./whatsappGraph.js";

/** Why a photo could not be had, when asking again will not help. */
export type WhatsAppMediaUnavailableReason = "not_found" | "too_large" | "invalid_response";

export type WhatsAppMediaDownload =
  | { readonly kind: "downloaded"; readonly bytes: Buffer }
  | { readonly kind: "unavailable"; readonly reason: WhatsAppMediaUnavailableReason };

interface WhatsAppMediaTransport {
  /** Reaches Graph, to resolve a media id. */
  readonly graphFetch: typeof fetch;
  /** Reaches the media host Graph names; the URL is Meta's data, so a host-bound public transport belongs here. */
  readonly mediaFetch: typeof fetch;
  readonly maxBytes: number;
  /** One budget for the Graph call and the download together. */
  readonly timeoutMs: number;
}

/** The raw upload cap the visitor-image module applies; a photo over it could not be stored anyway. */
export const WHATSAPP_MEDIA_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const WHATSAPP_MEDIA_DEFAULT_TIMEOUT_MS = 30_000;
/** The media URL may hand off to a CDN; a longer chain is not a photo link. */
const MAX_REDIRECTS = 2;

const unavailable = (reason: WhatsAppMediaUnavailableReason): WhatsAppMediaDownload => ({ kind: "unavailable", reason });

/**
 * What a non-2xx answer means. Graph answers 400 for an id that never existed or has expired, and
 * the media host 404 or 410 once the photo is gone: asking again will not help. A rate limit or a
 * server error is worth another attempt; a rejected token is not. The error carries the status
 * only, because a provider's own text can quote the request back.
 */
const failureForStatus = (status: number): "not_found" | WhatsAppClientError => {
  if (status === 400 || status === 404 || status === 410) {
    return "not_found";
  }
  return new WhatsAppClientError(
    `WhatsApp media request failed with status ${status}`,
    status,
    status === 429 || status >= 500,
  );
};

/** A link worth following: https, with no credentials in it. Anything else is not a photo link. */
const followableUrl = (value: string, base?: URL): URL | null => {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
};

const discard = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

/** Reads the body up to the cap and no further: a body that outgrows it is cut off, whatever it declared. */
const readCapped = async (response: Response, maxBytes: number): Promise<WhatsAppMediaDownload> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    return unavailable("too_large");
  }
  if (!response.body) {
    return unavailable("invalid_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return unavailable("too_large");
    }
    chunks.push(value);
  }
  return total === 0 ? unavailable("invalid_response") : { kind: "downloaded", bytes: Buffer.concat(chunks) };
};

/** Asks Graph where the media id's bytes are: the link, or why there is none to follow. */
const resolveMediaUrl = async (
  transport: WhatsAppMediaTransport,
  input: { accessToken: string; mediaId: string },
  signal: AbortSignal,
): Promise<URL | WhatsAppMediaDownload> => {
  const response = await transport.graphFetch(`${WHATSAPP_GRAPH_BASE_URL}/${encodeURIComponent(input.mediaId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${input.accessToken}` },
    signal,
  });
  if (!response.ok) {
    await discard(response);
    const failure = failureForStatus(response.status);
    if (failure === "not_found") {
      return unavailable("not_found");
    }
    throw failure;
  }
  let body: { url?: unknown; file_size?: unknown };
  try {
    body = await response.json() as { url?: unknown; file_size?: unknown };
  } catch {
    return unavailable("invalid_response");
  }
  if (typeof body.file_size === "number" && body.file_size > transport.maxBytes) {
    return unavailable("too_large");
  }
  const url = typeof body.url === "string" ? followableUrl(body.url) : null;
  return url ?? unavailable("invalid_response");
};

/**
 * Downloads one photo a customer sent: Graph resolves the media id to a link, and the link, with
 * the connector's token, serves the bytes. The size is bounded before anything is buffered (what
 * Graph says, what the response declares, and the bytes actually read), and the whole exchange is
 * bounded in time. A redirect is followed only to another https link, and the token goes only to
 * the host it was first sent to. A photo that cannot be had comes back as `unavailable`; a
 * transient failure throws a retryable `WhatsAppClientError`, with no provider text in it.
 */
export const downloadWhatsAppMedia = async (
  transport: WhatsAppMediaTransport,
  input: { accessToken: string; mediaId: string },
): Promise<WhatsAppMediaDownload> => {
  const signal = AbortSignal.timeout(transport.timeoutMs);
  try {
    const resolved = await resolveMediaUrl(transport, input, signal);
    if (!(resolved instanceof URL)) {
      return resolved;
    }

    let url: URL = resolved;
    let sendToken = true;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response: Response = await transport.mediaFetch(url.toString(), {
        method: "GET",
        headers: sendToken ? { Authorization: `Bearer ${input.accessToken}` } : {},
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location: string | null = response.headers.get("location");
        await discard(response);
        const next: URL | null = location ? followableUrl(location, url) : null;
        if (!next) {
          return unavailable("invalid_response");
        }
        sendToken = sendToken && next.host === url.host;
        url = next;
        continue;
      }
      if (!response.ok) {
        await discard(response);
        const failure = failureForStatus(response.status);
        if (failure === "not_found") {
          return unavailable("not_found");
        }
        throw failure;
      }
      return await readCapped(response, transport.maxBytes);
    }
    return unavailable("invalid_response");
  } catch (error) {
    if (error instanceof WhatsAppClientError) {
      throw error;
    }
    // The public transport refuses a link that does not resolve to a public host: asking again
    // reaches the same host, so it is not a link to fetch, whatever Graph said.
    if (error instanceof PublicNetworkPolicyError) {
      return unavailable("invalid_response");
    }
    throw signal.aborted
      ? new WhatsAppClientError("WhatsApp media download timed out", 504, true)
      : new WhatsAppClientError("WhatsApp media download failed", 502, true);
  }
};
