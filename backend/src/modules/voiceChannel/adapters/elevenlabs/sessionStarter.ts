import { z } from "zod";

import { VoiceVendorRequestError, type VoiceSessionStarter } from "../../domain.js";

const SIGNED_URL_ENDPOINT = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url";
/** ElevenLabs states that a signed URL opens sessions for 15 minutes after it is issued. */
const SIGNED_URL_VALIDITY_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
/** A signed-URL answer is a few hundred bytes; anything far larger is not one. */
const MAX_RESPONSE_BYTES = 16 * 1024;
/**
 * The hosts whose signed URLs the starter hands a browser. The page opens whatever URL it gets, so
 * one from any other host is refused rather than passed on.
 */
const SIGNED_URL_HOSTS: ReadonlySet<string> = new Set(["api.elevenlabs.io"]);

/**
 * The slice of `fetch` the starter uses, so tests and composition can hand in their own. A redirect
 * is an error: the key travels in a header, and following a 3xx would send it on to wherever the
 * redirect points.
 */
type SignedUrlFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; redirect: "error"; signal: AbortSignal },
) => Promise<Response>;

const signedUrlResponseSchema = z.object({ signed_url: z.string() });

const isAllowedSignedUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" && SIGNED_URL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};

/** Releases a body the starter will not read, so the connection can be reused. */
const discardBody = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

/** The body as text, or null when it is larger than `MAX_RESPONSE_BYTES`. */
const readBoundedText = async (response: Response): Promise<string | null> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await discardBody(response);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const parseSignedUrl = (text: string): string | null => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = signedUrlResponseSchema.safeParse(body);
  return parsed.success && isAllowedSignedUrl(parsed.data.signed_url) ? parsed.data.signed_url : null;
};

/**
 * Opens ElevenLabs Agents sessions: one signed URL per session, requested with the workspace's
 * ElevenLabs key in `xi-api-key`. The page passes the URL to the ElevenLabs client as `signedUrl`.
 */
export const createElevenLabsSessionStarter = (dependencies: {
  fetch: SignedUrlFetch;
  now?: () => number;
}): VoiceSessionStarter => ({
  startSession: async ({ vendorAgentId, credential }) => {
    const requestedAt = (dependencies.now ?? Date.now)();
    const url = `${SIGNED_URL_ENDPOINT}?${new URLSearchParams({ agent_id: vendorAgentId }).toString()}`;
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        method: "GET",
        headers: { "xi-api-key": credential.apiKey },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new VoiceVendorRequestError("unreachable");
    }
    if (!response.ok) {
      await discardBody(response);
      throw new VoiceVendorRequestError("rejected", response.status);
    }
    const text = await readBoundedText(response).catch(() => null);
    const signedUrl = text === null ? null : parseSignedUrl(text);
    if (!signedUrl) {
      throw new VoiceVendorRequestError("malformed_response", response.status);
    }
    return { signedUrl, expiresAt: new Date(requestedAt + SIGNED_URL_VALIDITY_MS) };
  },
});
