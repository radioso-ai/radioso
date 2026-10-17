import { z } from "zod";

import { VoiceRecordingRequestError, type VoiceRecordingSource, type VoiceRecordingStream } from "../../domain.js";
import { discardBody, isTimeout, readBoundedText } from "./fetchHelpers.js";
import { ELEVENLABS_API_HOST_OF_REGION } from "./hosts.js";

/** How long the vendor has to answer; once it has, the audio streams for as long as it lasts. */
const REQUEST_TIMEOUT_MS = 5_000;
/** One byte range, the only kind an audio element asks for. Header syntax, not vocabulary. */
const SINGLE_BYTE_RANGE = /^bytes=\d*-\d*$/;
/** ElevenLabs serves a conversation's audio as MP3. */
const DEFAULT_AUDIO_TYPE = "audio/mpeg";
/** What the vendor answers with when it holds no audio under the id: the call is unknown, or has not finished. */
const NOT_FOUND_STATUSES = new Set([404, 410]);
/**
 * A conversation document carries the transcript so far. Read right after the call opens it is a
 * few kilobytes; the cap leaves room for a report re-sent as the call ends, and refuses anything
 * far larger than a conversation.
 */
const MAX_CONVERSATION_DOCUMENT_BYTES = 64 * 1024;

const conversationDocumentSchema = z.object({ agent_id: z.string().min(1) });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

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

/** One request to the vendor: its answer, and the limit that still covers reading the body. */
interface VendorExchange {
  response: Response;
  /** Aborted when the limit passes or the listener goes away; the body read sees it. */
  signal: AbortSignal;
  /** Ends the limit; the listener can still stop the body. */
  answered(): void;
  /** Ends the limit and lets go of the listener. */
  release(): void;
}

/**
 * Sends one request with the vendor's limit, and with the listener's signal behind it, so a listener
 * who goes away stops the vendor's body too. The limit runs until `release`, so a caller that reads a
 * small body keeps it running through the read; the audio ends it once the vendor has answered.
 */
const openExchange = async (
  fetch: RecordingFetch,
  url: string,
  init: { method: "GET" | "DELETE"; headers: Record<string, string> },
  timeoutMs: number,
  listener?: AbortSignal,
): Promise<VendorExchange> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The vendor did not answer in time", "TimeoutError")), timeoutMs);
  const stop = (): void => controller.abort(listener?.reason);
  const answered = (): void => clearTimeout(timer);
  const release = (): void => {
    answered();
    listener?.removeEventListener("abort", stop);
  };
  if (listener?.aborted) stop();
  else listener?.addEventListener("abort", stop, { once: true });
  try {
    // Identity, so the lengths and ranges the vendor names are the bytes that arrive.
    const response = await fetch(url, { ...init, headers: { ...init.headers, "accept-encoding": "identity" }, redirect: "error", signal: controller.signal });
    return { response, signal: controller.signal, answered, release };
  } catch (error) {
    release();
    throw new VoiceRecordingRequestError(isTimeout(error, controller.signal) ? "timeout" : "unreachable");
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
    describeConversation: async ({ vendorConversationId, region, credential }) => {
      const exchange = await openExchange(
        dependencies.fetch,
        conversationUrl(region, vendorConversationId),
        { method: "GET", headers: { "xi-api-key": credential.apiKey } },
        timeoutMs,
      );
      const { response } = exchange;
      try {
        if (NOT_FOUND_STATUSES.has(response.status)) {
          await discardBody(response);
          throw new VoiceRecordingRequestError("not_found", response.status);
        }
        if (!response.ok) {
          await discardBody(response);
          throw new VoiceRecordingRequestError("rejected", response.status);
        }
        let text: string | null;
        try {
          text = await readBoundedText(response, MAX_CONVERSATION_DOCUMENT_BYTES);
        } catch (error) {
          throw new VoiceRecordingRequestError(isTimeout(error, exchange.signal) ? "timeout" : "unreachable", response.status);
        }
        const parsed = text === null ? null : conversationDocumentSchema.safeParse(parseJson(text));
        if (!parsed?.success) throw new VoiceRecordingRequestError("malformed_response", response.status);
        return { vendorAgentId: parsed.data.agent_id };
      } finally {
        exchange.release();
      }
    },
    fetchRecording: async ({ vendorConversationId, region, credential, range, signal }) => {
      const headers: Record<string, string> = { "xi-api-key": credential.apiKey };
      if (range && SINGLE_BYTE_RANGE.test(range.trim())) headers.range = range.trim();
      const exchange = await openExchange(
        dependencies.fetch,
        `${conversationUrl(region, vendorConversationId)}/audio`,
        { method: "GET", headers },
        timeoutMs,
        signal,
      );
      // The limit covers the answer; the audio then streams for as long as it lasts.
      exchange.answered();
      const { response } = exchange;
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
      const exchange = await openExchange(
        dependencies.fetch,
        conversationUrl(region, vendorConversationId),
        { method: "DELETE", headers: { "xi-api-key": credential.apiKey } },
        timeoutMs,
      );
      const { response } = exchange;
      await discardBody(response);
      exchange.release();
      if (response.ok || NOT_FOUND_STATUSES.has(response.status)) return;
      throw new VoiceRecordingRequestError("rejected", response.status);
    },
  };
};
