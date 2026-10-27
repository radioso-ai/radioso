import { describe, expect, it } from "vitest";

import {
  isAppBaseUrlPubliclyReachable,
  voiceRuntimeCompletionsAddress,
} from "../../src/app/composition/voiceRuntimeCompletionsAddress.js";

describe("voiceRuntimeCompletionsAddress", () => {
  it("is null when APP_BASE_URL is unset", () => {
    expect(voiceRuntimeCompletionsAddress(undefined)).toBeNull();
  });

  it("is null when APP_BASE_URL's host is not reachable from the public internet", () => {
    expect(voiceRuntimeCompletionsAddress("http://localhost:3000")).toBeNull();
  });

  it("builds the completions address under APP_BASE_URL's own /backend proxy path, trailing slash dropped", () => {
    const address = voiceRuntimeCompletionsAddress("https://app.example.com/");
    expect(address).not.toBeNull();
    expect(address!({ agentId: "agent-1", vendor: "elevenlabs" })).toBe(
      "https://app.example.com/backend/api/v1/agents/agent-1/voice/elevenlabs/v1",
    );
  });

  it("keeps a path APP_BASE_URL is served under", () => {
    const address = voiceRuntimeCompletionsAddress("https://example.com/radioso");
    expect(address!({ agentId: "agent-1", vendor: "elevenlabs" })).toBe(
      "https://example.com/radioso/backend/api/v1/agents/agent-1/voice/elevenlabs/v1",
    );
  });

  it("encodes the agent id and reads the vendor's own dialect", () => {
    const address = voiceRuntimeCompletionsAddress("https://app.example.com");
    expect(address!({ agentId: "agent/1", vendor: "elevenlabs" })).toBe(
      "https://app.example.com/backend/api/v1/agents/agent%2F1/voice/elevenlabs/v1",
    );
  });

  it("ignores a query string or fragment on APP_BASE_URL", () => {
    const address = voiceRuntimeCompletionsAddress("https://app.example.com/?region=eu#top");
    expect(address!({ agentId: "agent-1", vendor: "elevenlabs" })).toBe(
      "https://app.example.com/backend/api/v1/agents/agent-1/voice/elevenlabs/v1",
    );
  });
});

describe("isAppBaseUrlPubliclyReachable", () => {
  it.each([
    "https://app.radioso.ai",
    "https://example.com/radioso",
  ])("reads %s as reachable", (value) => {
    expect(isAppBaseUrlPubliclyReachable(value)).toBe(true);
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://backend.internal",
    "not a url",
  ])("reads %s as not reachable", (value) => {
    expect(isAppBaseUrlPubliclyReachable(value)).toBe(false);
  });
});
