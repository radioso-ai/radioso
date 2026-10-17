import { VoiceRecordingRequestError, type VoiceRecordingSource, type VoiceRecordingStream } from "../../domain.js";
import { ELEVENLABS_API_HOST_OF_REGION, discardBody, isTimeout } from "./hosts.js";

/** How long the vendor has to answer; once it has, the audio streams for as long as it lasts. */
const REQUEST_TIMEOUT_MS = 5_000;
/** One byte range, the only kind an audio element asks for. Header syntax, not vocabulary. */
const SINGLE_BYTE_RANGE = /^bytes=\d*-\d*$/;
/** ElevenLabs serves a conversation's audio as MP3. */
const DEFAULT_AUDIO_TYPE = "audio/mpeg";
/** What the vendor answers with when it holds no audio under the id: the call is unknown, or has not finished. */
const NOT_FOUND_STATUSES = new Set([404, 410]);

/**
 * The slice of `fetch` the source uses. A redirect is an error: the key travels in a header, and
 * following a 3xx would send it on to wherever the redirect points.
 */
type RecordingFetch = (
  url: string,
  init: { method: "GET" | "DELETE"; headers: Record<string, string>; redirect: "error"; signal: AbortSignal },
) => Promise<Response>;

const conversationUrl = (region: keyof typeof ELEVENLABS_API_HOST_OF_REGION, vendorConversationId: string): string =>
  `https://${ELEVENLABS_API_HOST_OF_REGION[region]}/v1/convai/conversations/${encodeURIComponent(vendorConversationId)}`;

const isAudio = (contentType: string): boolean => {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("audio/") || type === "application/octet-stream";
};

const declaredLength = (response: Response): number | undefined => {
  const value = response.headers.get("content-length");
  const length = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
};

/**
 * Sends one request with the vendor's answer limit, and with the listener's signal behind it, so a
 * listener who goes away stops the vendor's body too. The limit covers the answer, not the audio.
 */
const requestWithin = async (
  fetch: RecordingFetch,
  url: string,
  init: { method: "GET" | "DELETE"; headers: Record<string, string> },
  timeoutMs: number,
  listener?: AbortSignal,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The vendor did not answer in time", "TimeoutError")), timeoutMs);
  const stop = (): void => controller.abort(listener?.reason);
  if (listener?.aborted) stop();
  else listener?.addEventListener("abort", stop, { once: true });
  try {
    return await fetch(url, { ...init, redirect: "error", signal: controller.signal });
  } catch (error) {
    listener?.removeEventListener("abort", stop);
    throw new VoiceRecordingRequestError(isTimeout(error, controller.signal) ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Reads and deletes ElevenLabs Agents recordings with the workspace's ElevenLabs key in
 * `xi-api-key`, on the host of the account's data residency region. The audio streams through
 * untouched; an answer that is not audio is refused rather than passed on, so nothing the vendor
 * writes in an error body reaches the listener.
 */
export const createElevenLabsRecordingSource = (dependencies: {
  fetch: RecordingFetch;
  /** The vendor's answer limit; tests only. */
  requestTimeoutMs?: number;
}): VoiceRecordingSource => {
  const timeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    fetchRecording: async ({ vendorConversationId, region, credential, range, signal }) => {
      const headers: Record<string, string> = { "xi-api-key": credential.apiKey };
      if (range && SINGLE_BYTE_RANGE.test(range.trim())) headers.range = range.trim();
      const response = await requestWithin(
        dependencies.fetch,
        `${conversationUrl(region, vendorConversationId)}/audio`,
        { method: "GET", headers },
        timeoutMs,
        signal,
      );
      if (NOT_FOUND_STATUSES.has(response.status)) {
        await discardBody(response);
        throw new VoiceRecordingRequestError("not_found", response.status);
      }
      if (response.status !== 200 && response.status !== 206) {
        await discardBody(response);
        throw new VoiceRecordingRequestError("rejected", response.status);
      }
      const contentType = response.headers.get("content-type") ?? DEFAULT_AUDIO_TYPE;
      if (!response.body || !isAudio(contentType)) {
        await discardBody(response);
        throw new VoiceRecordingRequestError("malformed_response", response.status);
      }
      const contentLength = declaredLength(response);
      const contentRange = response.headers.get("content-range");
      const acceptRanges = response.headers.get("accept-ranges");
      const recording: VoiceRecordingStream = {
        status: response.status === 206 && contentRange ? 206 : 200,
        body: response.body,
        contentType,
        ...(contentLength === undefined ? {} : { contentLength }),
        ...(response.status === 206 && contentRange ? { contentRange } : {}),
        ...(acceptRanges ? { acceptRanges } : {}),
      };
      return recording;
    },
    deleteRecording: async ({ vendorConversationId, region, credential }) => {
      const response = await requestWithin(
        dependencies.fetch,
        conversationUrl(region, vendorConversationId),
        { method: "DELETE", headers: { "xi-api-key": credential.apiKey } },
        timeoutMs,
      );
      await discardBody(response);
      if (response.ok || NOT_FOUND_STATUSES.has(response.status)) return;
      throw new VoiceRecordingRequestError("rejected", response.status);
    },
  };
};
