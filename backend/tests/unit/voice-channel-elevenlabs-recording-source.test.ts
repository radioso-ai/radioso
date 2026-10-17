import { describe, expect, it, vi } from "vitest";

import { createElevenLabsRecordingSource } from "../../src/modules/voiceChannel/adapters/elevenlabs/recordingSource.js";
import { VoiceRecordingRequestError } from "../../src/modules/voiceChannel/domain.js";

const credential = { apiKey: "xi-secret-0123456789" };
const vendorConversationId = "conv_01jx8k2m3n4p5q6r7s8t9v0w1x";

type RecordingFetch = Parameters<typeof createElevenLabsRecordingSource>[0]["fetch"];

const audioResponse = (status: number, bytes: string, headers: Record<string, string> = {}) =>
  new Response(new TextEncoder().encode(bytes), { status, headers: { "content-type": "audio/mpeg", ...headers } });

const sourceWith = (
  respond: (url: string, init: Parameters<RecordingFetch>[1]) => Promise<Response>,
  requestTimeoutMs?: number,
  bodyIdleTimeoutMs?: number,
) => {
  const fetch = vi.fn<RecordingFetch>((url, init) => respond(url, init));
  return {
    fetch,
    source: createElevenLabsRecordingSource({
      fetch,
      ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
      ...(bodyIdleTimeoutMs ? { bodyIdleTimeoutMs } : {}),
    }),
  };
};

/** A vendor body the test feeds by hand. */
const manualBody = () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
  });
  return {
    body,
    push: (text: string) => controller!.enqueue(new TextEncoder().encode(text)),
    close: () => controller!.close(),
  };
};

const rejectionOf = async (promise: Promise<unknown>): Promise<VoiceRecordingRequestError> => {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(VoiceRecordingRequestError);
  return error as VoiceRecordingRequestError;
};

const textOf = async (body: ReadableStream<Uint8Array>): Promise<string> => new Response(body).text();

describe("ElevenLabs recording source", () => {
  it("asks the account's region host for the conversation's audio with the workspace key in xi-api-key, and follows no redirect", async () => {
    const { fetch, source } = sourceWith(async () => audioResponse(200, "ID3audio"));

    await source.fetchRecording({ vendorConversationId, region: "eu", credential });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://api.eu.residency.elevenlabs.io/v1/convai/conversations/${vendorConversationId}/audio`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ "xi-api-key": credential.apiKey, "accept-encoding": "identity" });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["us", "api.elevenlabs.io"],
    ["in", "api.in.residency.elevenlabs.io"],
    ["sg", "api.sg.residency.elevenlabs.io"],
  ] as const)("reads a %s account's recording from %s", async (region, host) => {
    const { fetch, source } = sourceWith(async () => audioResponse(200, "ID3audio"));

    await source.fetchRecording({ vendorConversationId, region, credential });

    expect(new URL(fetch.mock.calls[0][0]).host).toBe(host);
  });

  it("streams the vendor's audio with its content type and length", async () => {
    const { source } = sourceWith(async () => audioResponse(200, "ID3audio", { "content-length": "8", "accept-ranges": "bytes" }));

    const recording = await source.fetchRecording({ vendorConversationId, region: "us", credential });

    expect(recording).toMatchObject({ status: 200, contentType: "audio/mpeg", contentLength: 8, acceptRanges: "bytes" });
    expect(await textOf(recording.body)).toBe("ID3audio");
  });

  it("passes one byte range on and returns the vendor's partial answer", async () => {
    const { fetch, source } = sourceWith(async () => audioResponse(206, "aud", { "content-range": "bytes 3-5/8", "content-length": "3" }));

    const recording = await source.fetchRecording({ vendorConversationId, region: "us", credential, range: "bytes=3-5" });

    expect(fetch.mock.calls[0][1].headers).toEqual({ "xi-api-key": credential.apiKey, range: "bytes=3-5", "accept-encoding": "identity" });
    expect(recording).toMatchObject({ status: 206, contentRange: "bytes 3-5/8", contentLength: 3 });
  });

  it("serves the whole recording when the vendor ignores the range", async () => {
    const { source } = sourceWith(async () => audioResponse(200, "ID3audio"));

    const recording = await source.fetchRecording({ vendorConversationId, region: "us", credential, range: "bytes=3-" });

    expect(recording.status).toBe(200);
    expect(recording.contentRange).toBeUndefined();
  });

  it.each(["bytes=0-1,5-6", "bytes=-", "bytes=a-b", "items=0-5"])("leaves %s, which is not one byte range, behind", async (range) => {
    const { fetch, source } = sourceWith(async () => audioResponse(200, "ID3audio"));

    await source.fetchRecording({ vendorConversationId, region: "us", credential, range });

    expect(fetch.mock.calls[0][1].headers).toEqual({ "xi-api-key": credential.apiKey, "accept-encoding": "identity" });
  });

  it.each(["bytes=0-", "bytes=10-20", "bytes=-500"])("passes the single byte range %s on", async (range) => {
    const { fetch, source } = sourceWith(async () => audioResponse(200, "ID3audio"));

    await source.fetchRecording({ vendorConversationId, region: "us", credential, range });

    expect(fetch.mock.calls[0][1].headers).toMatchObject({ range });
  });

  it("refuses a partial answer that does not say which bytes it carries", async () => {
    const { source } = sourceWith(async () => audioResponse(206, "aud"));

    const error = await rejectionOf(source.fetchRecording({ vendorConversationId, region: "us", credential, range: "bytes=3-5" }));

    expect(error).toMatchObject({ reason: "malformed_response", vendorStatus: 206 });
  });

  it("passes a range the vendor cannot satisfy on, with the vendor's length", async () => {
    const { source } = sourceWith(async () => new Response(null, { status: 416, headers: { "content-range": "bytes */8" } }));

    const error = await rejectionOf(source.fetchRecording({ vendorConversationId, region: "us", credential, range: "bytes=50-" }));

    expect(error).toMatchObject({ reason: "range_not_satisfiable", vendorStatus: 416, contentRange: "bytes */8" });
  });

  it("names no length or range for a body the vendor encoded anyway, and refuses an encoded partial answer", async () => {
    const encoded = sourceWith(async () => audioResponse(200, "ID3audio", { "content-encoding": "gzip", "content-length": "5" }));
    const whole = await encoded.source.fetchRecording({ vendorConversationId, region: "us", credential });
    expect(whole.contentLength).toBeUndefined();

    const encodedPart = sourceWith(async () => audioResponse(206, "aud", { "content-encoding": "gzip", "content-range": "bytes 3-5/8" }));
    expect((await rejectionOf(encodedPart.source.fetchRecording({ vendorConversationId, region: "us", credential, range: "bytes=3-5" }))).reason)
      .toBe("malformed_response");
  });

  it("gives up on a body that stalls while the listener waits for it, and stops the vendor's body", async () => {
    const vendor = manualBody();
    let vendorSignal: AbortSignal | null = null;
    const { source } = sourceWith(async (_url, init) => {
      vendorSignal = init.signal;
      return new Response(vendor.body, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }, undefined, 20);

    const recording = await source.fetchRecording({ vendorConversationId, region: "us", credential });
    const reader = recording.body.getReader();
    vendor.push("ID3");
    await expect(reader.read()).resolves.toMatchObject({ done: false });

    await expect(reader.read()).rejects.toMatchObject({ reason: "timeout" });
    expect(vendorSignal!.aborted).toBe(true);
  });

  it("waits as long as the listener pauses: only a read the vendor leaves unanswered counts", async () => {
    const vendor = manualBody();
    const { source } = sourceWith(async () => new Response(vendor.body, { status: 200, headers: { "content-type": "audio/mpeg" } }), undefined, 20);

    const recording = await source.fetchRecording({ vendorConversationId, region: "us", credential });
    const reader = recording.body.getReader();
    vendor.push("ID3");
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 60));
    vendor.push("more");
    vendor.close();

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("reads a listener who went away before the vendor answered as abandoned, not as the vendor timing out", async () => {
    const listener = new AbortController();
    const { source } = sourceWith((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      listener.abort();
    }));

    const error = await rejectionOf(source.fetchRecording({ vendorConversationId, region: "us", credential, signal: listener.signal }));

    expect(error.reason).toBe("abandoned");
  });

  it("reads an unknown conversation, or one without audio yet, as not found", async () => {
    const { source } = sourceWith(async () => new Response(JSON.stringify({ detail: "Conversation not found" }), { status: 404 }));

    const error = await rejectionOf(source.fetchRecording({ vendorConversationId, region: "us", credential }));

    expect(error.reason).toBe("not_found");
  });

  it("reads any other refusal as rejected with the vendor's status, and never carries the vendor's body", async () => {
    const { source } = sourceWith(async () => new Response(JSON.stringify({ detail: "invalid api key xi-secret" }), { status: 401 }));

    const error = await rejectionOf(source.fetchRecording({ vendorConversationId, region: "us", credential }));

    expect(error).toMatchObject({ reason: "rejected", vendorStatus: 401 });
    expect(error.message).not.toContain("xi-secret");
  });

  it("refuses an answer that is not audio", async () => {
    const { source } = sourceWith(async () => new Response(JSON.stringify({ detail: "x" }), { status: 200, headers: { "content-type": "application/json" } }));

    const error = await rejectionOf(source.fetchRecording({ vendorConversationId, region: "us", credential }));

    expect(error).toMatchObject({ reason: "malformed_response", vendorStatus: 200 });
  });

  it("reads a vendor that cannot be reached as unreachable, and one that does not answer in time as a timeout", async () => {
    const unreachable = sourceWith(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await rejectionOf(unreachable.source.fetchRecording({ vendorConversationId, region: "us", credential }))).reason).toBe("unreachable");

    const slow = sourceWith((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }), 20);
    expect((await rejectionOf(slow.source.fetchRecording({ vendorConversationId, region: "us", credential }))).reason).toBe("timeout");
  });

  it("keeps streaming past the answer limit once the vendor has answered", async () => {
    let push: ((text: string) => void) | null = null;
    let close: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
        close = () => controller.close();
      },
    });
    const { source } = sourceWith(async (_url, init) => {
      init.signal.addEventListener("abort", () => close?.());
      return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }, 20);

    const recording = await source.fetchRecording({ vendorConversationId, region: "us", credential });
    await new Promise((resolve) => setTimeout(resolve, 40));
    push!("late");
    close!();

    expect(await textOf(recording.body)).toBe("late");
  });

  it("stops the vendor's body when the listener goes away", async () => {
    const listener = new AbortController();
    let vendorSignal: AbortSignal | null = null;
    const { source } = sourceWith(async (_url, init) => {
      vendorSignal = init.signal;
      return audioResponse(200, "ID3audio");
    });

    await source.fetchRecording({ vendorConversationId, region: "us", credential, signal: listener.signal });
    listener.abort();

    expect(vendorSignal!.aborted).toBe(true);
  });

  it("deletes the conversation on the account's region host", async () => {
    const { fetch, source } = sourceWith(async () => new Response("{}", { status: 200 }));

    await source.deleteRecording({ vendorConversationId, region: "eu", credential });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://api.eu.residency.elevenlabs.io/v1/convai/conversations/${vendorConversationId}`);
    expect(init).toMatchObject({ method: "DELETE", headers: { "xi-api-key": credential.apiKey }, redirect: "error" });
  });

  it("counts a conversation the vendor no longer holds as deleted", async () => {
    const { source } = sourceWith(async () => new Response("{}", { status: 404 }));

    await expect(source.deleteRecording({ vendorConversationId, region: "us", credential })).resolves.toBeUndefined();
  });

  it("rejects a delete the vendor refuses", async () => {
    const { source } = sourceWith(async () => new Response("{}", { status: 500 }));

    const error = await rejectionOf(source.deleteRecording({ vendorConversationId, region: "us", credential }));

    expect(error).toMatchObject({ reason: "rejected", vendorStatus: 500 });
  });

  describe("checking a reported conversation", () => {
    const conversationDocument = (agentId: string) =>
      new Response(JSON.stringify({ agent_id: agentId, conversation_id: vendorConversationId, status: "in-progress", transcript: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    it("reads the conversation on the account's region host with the workspace key, following no redirect", async () => {
      const { fetch, source } = sourceWith(async () => conversationDocument("agent_42"));

      await expect(source.describeConversation({ vendorConversationId, region: "eu", credential })).resolves.toEqual({ vendorAgentId: "agent_42" });

      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(`https://api.eu.residency.elevenlabs.io/v1/convai/conversations/${vendorConversationId}`);
      expect(init).toMatchObject({ method: "GET", headers: { "xi-api-key": credential.apiKey, "accept-encoding": "identity" }, redirect: "error" });
    });

    it("reads an unknown conversation as not found, and any other refusal as rejected", async () => {
      const missing = sourceWith(async () => new Response("{}", { status: 404 }));
      expect((await rejectionOf(missing.source.describeConversation({ vendorConversationId, region: "us", credential }))).reason).toBe("not_found");

      const refused = sourceWith(async () => new Response("{}", { status: 401 }));
      expect(await rejectionOf(refused.source.describeConversation({ vendorConversationId, region: "us", credential })))
        .toMatchObject({ reason: "rejected", vendorStatus: 401 });
    });

    it("refuses an answer without the agent, and one far larger than a conversation document", async () => {
      const unnamed = sourceWith(async () => new Response(JSON.stringify({ status: "done" }), { status: 200 }));
      expect((await rejectionOf(unnamed.source.describeConversation({ vendorConversationId, region: "us", credential }))).reason)
        .toBe("malformed_response");

      const huge = sourceWith(async () => new Response(JSON.stringify({ agent_id: "agent_42", transcript: "x".repeat(70 * 1024) }), { status: 200 }));
      expect((await rejectionOf(huge.source.describeConversation({ vendorConversationId, region: "us", credential }))).reason)
        .toBe("malformed_response");
    });
  });
});
