import { describe, expect, it, vi } from "vitest";

import { createElevenLabsSessionStarter } from "../../src/modules/voiceChannel/adapters/elevenlabs/sessionStarter.js";
import { VoiceVendorRequestError } from "../../src/modules/voiceChannel/domain.js";

const signedUrl = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const now = Date.parse("2026-10-16T12:00:00.000Z");
const credential = { apiKey: "xi-secret-0123456789" };

type StarterFetch = Parameters<typeof createElevenLabsSessionStarter>[0]["fetch"];

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const starterWith = (respond: (init: Parameters<StarterFetch>[1]) => Promise<Response>, requestTimeoutMs?: number) => {
  const fetch = vi.fn<StarterFetch>((_url, init) => respond(init));
  return { fetch, starter: createElevenLabsSessionStarter({ fetch, now: () => now, ...(requestTimeoutMs ? { requestTimeoutMs } : {}) }) };
};

const rejectionOf = async (promise: Promise<unknown>): Promise<VoiceVendorRequestError> => {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(VoiceVendorRequestError);
  return error as VoiceVendorRequestError;
};

/** A body whose cancellation the test can see. */
const trackedBody = (text: string) => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel,
  });
  return { body, cancel };
};

describe("ElevenLabs session starter", () => {
  it("asks ElevenLabs for a signed url for the vendor agent with the workspace key in xi-api-key, and follows no redirect", async () => {
    const { fetch, starter } = starterWith(async () => jsonResponse(200, { signed_url: signedUrl }));

    await starter.startSession({ vendorAgentId: "agent_42", region: "us", credential });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_42");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ "xi-api-key": credential.apiKey });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the signed url and when it stops opening sessions, 15 minutes after the request", async () => {
    const { starter } = starterWith(async () => jsonResponse(200, { signed_url: signedUrl }));

    expect(await starter.startSession({ vendorAgentId: "agent_42", region: "us", credential })).toEqual({
      signedUrl,
      expiresAt: new Date("2026-10-16T12:15:00.000Z"),
    });
  });

  it("rejects with the vendor's status when ElevenLabs refuses the key or the agent, and releases the body", async () => {
    const { body, cancel } = trackedBody(JSON.stringify({ detail: { status: "invalid_api_key" } }));
    const { starter } = starterWith(async () => new Response(body, { status: 401 }));

    const error = await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", region: "us", credential }));

    expect(error.reason).toBe("rejected");
    expect(error.vendorStatus).toBe(401);
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects as unreachable when the request never gets an answer, a redirect included", async () => {
    const { starter } = starterWith(async () => {
      throw new TypeError("fetch failed");
    });

    expect((await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", region: "us", credential }))).reason).toBe("unreachable");
  });

  it.each([
    ["a body that is not JSON", async () => new Response("<html>Bad gateway</html>", { status: 200 })],
    ["a body without a signed url", async () => jsonResponse(200, { url: signedUrl })],
    ["a signed url that is not a WebSocket url", async () => jsonResponse(200, { signed_url: "https://api.elevenlabs.io/v1/convai/conversation" })],
    ["a signed url on another host", async () => jsonResponse(200, { signed_url: "wss://evil.example.com/v1/convai/conversation?agent_id=agent_42" })],
    ["a signed url on a lookalike host", async () => jsonResponse(200, { signed_url: "wss://api.elevenlabs.io.evil.example.com/v1/convai" })],
  ])("rejects %s as a malformed answer", async (_case, respond) => {
    const { starter } = starterWith(respond);

    expect((await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", region: "us", credential }))).reason).toBe("malformed_response");
  });

  it("refuses a body declared larger than 16 KB without reading it", async () => {
    const { body, cancel } = trackedBody(JSON.stringify({ signed_url: signedUrl }));
    const { starter } = starterWith(async () => new Response(body, { status: 200, headers: { "content-length": String(64 * 1024) } }));

    expect((await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", region: "us", credential }))).reason).toBe("malformed_response");
    expect(cancel).toHaveBeenCalled();
  });

  it("stops reading a body that grows past 16 KB", async () => {
    const { starter } = starterWith(async () => new Response(JSON.stringify({ signed_url: signedUrl, padding: "x".repeat(32 * 1024) }), { status: 200 }));

    expect((await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", region: "us", credential }))).reason).toBe("malformed_response");
  });

  it("asks an EU-residency account's own host, and accepts a signed url on it", async () => {
    const euSignedUrl = "wss://api.eu.residency.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
    const { fetch, starter } = starterWith(async () => jsonResponse(200, { signed_url: euSignedUrl }));

    const session = await starter.startSession({ vendorAgentId: "agent_42", region: "eu", credential });

    expect(fetch.mock.calls[0][0]).toBe("https://api.eu.residency.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_42");
    expect(session.signedUrl).toBe(euSignedUrl);
  });

  it("refuses a signed url from another region's host than the account's", async () => {
    const { starter } = starterWith(async () => jsonResponse(200, {
      signed_url: "wss://api.eu.residency.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig",
    }));

    expect((await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", region: "us", credential }))).reason).toBe("malformed_response");
  });

  it("reports an answer that stalls mid-body as a timeout, not a malformed answer", async () => {
    const { starter } = starterWith(async (init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"signed_url":"wss://api.elevenlabs.io/v1/'));
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
      },
    }), { status: 200 }), 20);

    const error = await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", region: "us", credential }));

    expect(error.reason).toBe("timeout");
  });

  it("reports a request that never answers in time as a timeout", async () => {
    const { starter } = starterWith((init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }), 20);

    expect((await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", region: "us", credential }))).reason).toBe("timeout");
  });

  it("never names the key in the error it raises", async () => {
    const { starter } = starterWith(async () => jsonResponse(403, {}));

    const error = await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", region: "us", credential }));

    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(credential.apiKey);
  });
});
