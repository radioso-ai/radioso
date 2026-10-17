import { z } from "zod";

import { VOICE_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";
import { VoiceVendorRequestError, type VoiceSessionStarter } from "../../domain.js";
import { discardBody, isTimeout, readBoundedText } from "./fetchHelpers.js";
import { ELEVENLABS_API_HOST_OF_REGION } from "./hosts.js";

// The signed-URL request goes to the account's region host, and the signed URL handed to the
// browser must be on that same host: the page opens whatever URL it gets, so one from any other
// host is refused rather than passed on.
const SIGNED_URL_PATH = "/v1/convai/conversation/get-signed-url";
const REQUEST_TIMEOUT_MS = 5_000;
/** A signed-URL answer is a few hundred bytes; anything far larger is not one. */
const MAX_RESPONSE_BYTES = 16 * 1024;

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

const isSignedUrlOnHost = (value: string, host: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" && url.hostname === host;
  } catch {
    return false;
  }
};

const parseSignedUrl = (text: string, host: string): string | null => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = signedUrlResponseSchema.safeParse(body);
  return parsed.success && isSignedUrlOnHost(parsed.data.signed_url, host) ? parsed.data.signed_url : null;
};

/** A body read that failed: the request's time ran out mid-body, or the connection broke. */
const bodyReadFailure = (error: unknown, signal: AbortSignal, status: number): VoiceVendorRequestError =>
  new VoiceVendorRequestError(isTimeout(error, signal) ? "timeout" : "unreachable", status);

/**
 * Opens ElevenLabs Agents sessions: one signed URL per session, requested with the workspace's
 * ElevenLabs key in `xi-api-key`. The page passes the URL to the ElevenLabs client as `signedUrl`.
 */
export const createElevenLabsSessionStarter = (dependencies: {
  fetch: SignedUrlFetch;
  now?: () => number;
  /** The whole request's limit, answer body included; tests only. */
  requestTimeoutMs?: number;
}): VoiceSessionStarter => ({
  startSession: async ({ vendorAgentId, region, credential }) => {
    const requestedAt = (dependencies.now ?? Date.now)();
    const host = ELEVENLABS_API_HOST_OF_REGION[region];
    const url = `https://${host}${SIGNED_URL_PATH}?${new URLSearchParams({ agent_id: vendorAgentId }).toString()}`;
    const signal = AbortSignal.timeout(dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        method: "GET",
        headers: { "xi-api-key": credential.apiKey },
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw new VoiceVendorRequestError(isTimeout(error, signal) ? "timeout" : "unreachable");

    }
    if (!response.ok) {
      await discardBody(response);
      throw new VoiceVendorRequestError("rejected", response.status);
    }
    let text: string | null;
    try {
      text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw bodyReadFailure(error, signal, response.status);
    }
    const signedUrl = text === null ? null : parseSignedUrl(text, host);
    if (!signedUrl) {
      throw new VoiceVendorRequestError("malformed_response", response.status);
    }
    return { signedUrl, expiresAt: new Date(requestedAt + VOICE_BEHAVIOR.elevenLabsSignedUrlValidityMs) };
  },
});
