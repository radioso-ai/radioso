import { z } from "zod";

import { VoiceRecordingRequestError, type VoiceRecordingSource, type VoiceRecordingStream } from "../../domain.js";
import { discardBody, isTimeout, readBoundedText } from "./fetchHelpers.js";
import { ELEVENLABS_API_HOST_OF_REGION } from "./hosts.js";

/** How long the vendor has to answer; once it has, the audio streams for as long as it lasts. */
const REQUEST_TIMEOUT_MS = 5_000;
/** One byte range, the only kind an audio element asks for. Header syntax, not vocabulary. */
const SINGLE_BYTE_RANGE = /^bytes=(\d+-\d*|-\d+)$/;
/**
 * How long the audio may go without a byte while the listener waits for one. A listener who pauses
 * reads nothing, so a pause never counts; a vendor that stops sending lets go of the socket.
 */
const BODY_IDLE_TIMEOUT_MS = 15_000;
/** ElevenLabs serves a conversation's audio as MP3. */
const DEFAULT_AUDIO_TYPE = "audio/mpeg";
/** What the vendor answers with when it holds no audio under the id: the call is unknown, or has not finished. */
const NOT_FOUND_STATUSES = new Set([404, 410]);

/** `Retry-After` as delta-seconds or an HTTP date. Header syntax only. */
const RETRY_AFTER_SECONDS = /^\d+$/;

/** How long the vendor asks to be left alone, in whole seconds from now; undefined when it names no time it can be read as. */
const retryAfterSecondsOf = (response: Response): number | undefined => {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (RETRY_AFTER_SECONDS.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1_000));
};
/**
 * A conversation document carries the transcript so far, and the vendor offers no way to ask for
 * the agent alone. Read right after the call opens it is a few kilobytes; a report re-sent as a long
 * call ends reads it whole, so the cap is well past any call's transcript and only bounds what one
 * report may hold in memory.
 */
const MAX_CONVERSATION_DOCUMENT_BYTES = 2 * 1024 * 1024;

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

/** The vendor's declared length; none for a header that is missing, empty or not a whole number. */
const declaredLength = (response: Response): number | undefined => {
  const value = response.headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
};

/** One request to the vendor: its answer, and the limit that still covers reading the body. */
interface VendorExchange {
  response: Response;
  /** Aborted when the limit passes or the listener goes away; the body read sees it. */
  signal: AbortSignal;
  /** Ends the limit; the listener can still stop the body. */
  answered(): void;
  /** Stops the request and its body. */
  abort(reason: Error): void;
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
    return { response, signal: controller.signal, answered, abort: (reason) => controller.abort(reason), release };
  } catch (error) {
    release();
    if (listener?.aborted) throw new VoiceRecordingRequestError("abandoned");
    throw new VoiceRecordingRequestError(isTimeout(error, controller.signal) ? "timeout" : "unreachable");
  }
};

/**
 * The vendor's body, read only when the listener asks for more, with a stall limit on each read the
 * vendor leaves waiting. `ended` runs once the body is done, whichever way.
 */
const watchedBody = (
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  stall: (error: VoiceRecordingRequestError) => void,
  ended: () => void,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let finished = false;
  const end = (): void => {
    if (finished) return;
    finished = true;
    ended();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new VoiceRecordingRequestError("timeout")), idleMs);
      });
      try {
        const chunk = await Promise.race([reader.read(), stalled]);
        if (chunk.done) {
          controller.close();
          end();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        const failure = error instanceof VoiceRecordingRequestError ? error : new VoiceRecordingRequestError("unreachable");
        stall(failure);
        await reader.cancel(failure).catch(() => undefined);
        controller.error(failure);
        end();
      } finally {
        clearTimeout(timer);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      end();
    },
  }, { highWaterMark: 0 });
};

/** Whether a body arrives encoded, so its declared length and ranges name other bytes than the audio's. */
const isEncoded = (response: Response): boolean => {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  return Boolean(encoding) && encoding !== "identity";
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
  /** The audio's stall limit; tests only. */
  bodyIdleTimeoutMs?: number;
}): VoiceRecordingSource => {
  const timeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const idleMs = dependencies.bodyIdleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS;
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
        if (text === null) throw new VoiceRecordingRequestError("oversized_response", response.status);
        const parsed = conversationDocumentSchema.safeParse(parseJson(text));
        if (!parsed.success) throw new VoiceRecordingRequestError("malformed_response", response.status);
        return { vendorAgentId: parsed.data.agent_id };
      } finally {
        exchange.release();
      }
    },
    fetchRecording: async ({ vendorConversationId, region, credential, range, signal }) => {
      const headers: Record<string, string> = { "xi-api-key": credential.apiKey };
      const asked = range?.trim();
      if (asked && SINGLE_BYTE_RANGE.test(asked)) headers.range = asked;
      const exchange = await openExchange(
        dependencies.fetch,
        `${conversationUrl(region, vendorConversationId)}/audio`,
        { method: "GET", headers },
        timeoutMs,
        signal,
      );
      // The limit covers the answer; the audio then streams for as long as it keeps arriving.
      exchange.answered();
      const { response } = exchange;
      const refuse = async (error: VoiceRecordingRequestError): Promise<never> => {
        await discardBody(response);
        exchange.release();
        throw error;
      };
      if (NOT_FOUND_STATUSES.has(response.status)) return refuse(new VoiceRecordingRequestError("not_found", response.status));
      if (response.status === 416) {
        return refuse(new VoiceRecordingRequestError("range_not_satisfiable", 416, response.headers.get("content-range") ?? undefined));
      }
      if (response.status !== 200 && response.status !== 206) return refuse(new VoiceRecordingRequestError("rejected", response.status));
      const contentType = response.headers.get("content-type") ?? DEFAULT_AUDIO_TYPE;
      const encoded = isEncoded(response);
      const contentRange = response.headers.get("content-range") ?? undefined;
      const partial = response.status === 206;
      // A part that does not say which bytes it holds, or holds encoded bytes, cannot be passed on as a part.
      if (!response.body || !isAudio(contentType) || (partial && (!contentRange || encoded))) {
        return refuse(new VoiceRecordingRequestError("malformed_response", response.status));
      }
      const contentLength = encoded ? undefined : declaredLength(response);
      const acceptRanges = response.headers.get("accept-ranges");
      const recording: VoiceRecordingStream = {
        status: partial ? 206 : 200,
        body: watchedBody(response.body, idleMs, (error) => exchange.abort(error), () => exchange.release()),
        contentType,
        ...(contentLength === undefined ? {} : { contentLength }),
        ...(partial && contentRange ? { contentRange } : {}),
        ...(acceptRanges && !encoded ? { acceptRanges } : {}),
      };
      return recording;
    },
    deleteRecording: async ({ vendorConversationId, region, credential, signal }) => {
      const exchange = await openExchange(
        dependencies.fetch,
        conversationUrl(region, vendorConversationId),
        { method: "DELETE", headers: { "xi-api-key": credential.apiKey } },
        timeoutMs,
        signal,
      );
      const { response } = exchange;
      await discardBody(response);
      exchange.release();
      if (response.ok) return "deleted";
      if (NOT_FOUND_STATUSES.has(response.status)) return "already_absent";
      throw new VoiceRecordingRequestError("rejected", response.status, undefined, retryAfterSecondsOf(response));
    },
  };
};
