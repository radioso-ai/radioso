import { z } from "zod";

import { VoiceVendorRequestError, type VoiceSessionStarter } from "../../domain.js";

const SIGNED_URL_ENDPOINT = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url";
/** ElevenLabs states that a signed URL opens sessions for 15 minutes after it is issued. */
const SIGNED_URL_VALIDITY_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

/** The slice of `fetch` the starter uses, so tests and composition can hand in their own. */
type SignedUrlFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// A signed URL is a WebSocket URL; anything else is not a session the browser SDK can open.
const signedUrlResponseSchema = z.object({ signed_url: z.string().url().startsWith("wss://") });

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
    let response: Awaited<ReturnType<SignedUrlFetch>>;
    try {
      response = await dependencies.fetch(url, {
        method: "GET",
        headers: { "xi-api-key": credential.apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new VoiceVendorRequestError("unreachable");
    }
    if (!response.ok) {
      throw new VoiceVendorRequestError("rejected", response.status);
    }
    const body = await response.json().catch(() => null);
    const parsed = signedUrlResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new VoiceVendorRequestError("malformed_response", response.status);
    }
    return { signedUrl: parsed.data.signed_url, expiresAt: new Date(requestedAt + SIGNED_URL_VALIDITY_MS) };
  },
});
