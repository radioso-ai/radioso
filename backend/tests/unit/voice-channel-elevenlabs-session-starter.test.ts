import { describe, expect, it, vi } from "vitest";

import { createElevenLabsSessionStarter } from "../../src/modules/voiceChannel/adapters/elevenlabs/sessionStarter.js";
import { VoiceVendorRequestError } from "../../src/modules/voiceChannel/domain.js";

const signedUrl = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const now = Date.parse("2026-10-16T12:00:00.000Z");
const credential = { apiKey: "xi-secret-0123456789" };

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const starterWith = (respond: () => Promise<ReturnType<typeof jsonResponse>>) => {
  const fetch = vi.fn((_url: string, _init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) => respond());
  return { fetch, starter: createElevenLabsSessionStarter({ fetch, now: () => now }) };
};

const rejectionOf = async (promise: Promise<unknown>): Promise<VoiceVendorRequestError> => {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(VoiceVendorRequestError);
  return error as VoiceVendorRequestError;
};

describe("ElevenLabs session starter", () => {
  it("asks ElevenLabs for a signed url for the vendor agent with the workspace key in xi-api-key", async () => {
    const { fetch, starter } = starterWith(async () => jsonResponse(200, { signed_url: signedUrl }));

    await starter.startSession({ vendorAgentId: "agent_42", credential });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_42");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ "xi-api-key": credential.apiKey });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the signed url and when it stops opening sessions, 15 minutes after the request", async () => {
    const { starter } = starterWith(async () => jsonResponse(200, { signed_url: signedUrl }));

    expect(await starter.startSession({ vendorAgentId: "agent_42", credential })).toEqual({
      signedUrl,
      expiresAt: new Date("2026-10-16T12:15:00.000Z"),
    });
  });

  it("rejects with the vendor's status when ElevenLabs refuses the key or the agent", async () => {
    const { starter } = starterWith(async () => jsonResponse(401, { detail: { status: "invalid_api_key" } }));

    const error = await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", credential }));

    expect(error.reason).toBe("rejected");
    expect(error.vendorStatus).toBe(401);
  });

  it("rejects as unreachable when the request never gets an answer", async () => {
    const { starter } = starterWith(async () => {
      throw new TypeError("fetch failed");
    });

    expect((await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", credential }))).reason).toBe("unreachable");
  });

  it.each([
    ["a body that is not JSON", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } })],
    ["a body without a signed url", async () => jsonResponse(200, { url: signedUrl })],
    ["a signed url that is not a WebSocket url", async () => jsonResponse(200, { signed_url: "https://example.com/session" })],
  ])("rejects %s as a malformed answer", async (_case, respond) => {
    const { starter } = starterWith(respond);

    expect((await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", credential }))).reason).toBe("malformed_response");
  });

  it("never names the key in the error it raises", async () => {
    const { starter } = starterWith(async () => jsonResponse(403, {}));

    const error = await rejectionOf(starter.startSession({ vendorAgentId: "agent_42", credential }));

    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(credential.apiKey);
  });
});
