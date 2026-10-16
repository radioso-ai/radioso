import { describe, expect, it, vi } from "vitest";

import type { AgentVoiceSettings } from "../../src/modules/agents/public.js";
import { VoiceVendorRequestError, type VoiceSessionStarter } from "../../src/modules/voiceChannel/domain.js";
import { VoiceSessionStartService } from "../../src/modules/voiceChannel/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const sessionKey = "33333333-3333-4333-8333-333333333333";
const apiKey = "xi-secret-0123456789";
const signedUrl = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const expiresAt = new Date("2026-10-16T12:15:00.000Z");

const boundVoice: AgentVoiceSettings = {
  enabled: true,
  bridgeLines: {},
  fallbackLine: {},
  runtime: { vendor: "elevenlabs", agentId: "agent_42" },
};

const fakeLogger = () => ({ warn: vi.fn() });
const fakeMetrics = () => ({ incrementCounter: vi.fn() });

const serviceWith = (overrides: {
  voice?: AgentVoiceSettings | null;
  defaultLocale?: string | null;
  credential?: { apiKey: string } | null | Error;
  starter?: VoiceSessionStarter["startSession"];
} = {}) => {
  const logger = fakeLogger();
  const metrics = fakeMetrics();
  const startSession = vi.fn<VoiceSessionStarter["startSession"]>(overrides.starter ?? (async () => ({ signedUrl, expiresAt })));
  const read = vi.fn(async () => {
    const credential = overrides.credential === undefined ? { apiKey } : overrides.credential;
    if (credential instanceof Error) throw credential;
    return credential;
  });
  const voice = overrides.voice === undefined ? boundVoice : overrides.voice;
  const service = new VoiceSessionStartService({
    agents: {
      findVoiceProfile: async () => (voice ? { voice, defaultLocale: overrides.defaultLocale ?? null } : null),
    },
    credentials: { read },
    starters: { elevenlabs: { startSession } },
    newSessionKey: () => sessionKey,
    metrics,
    logger,
  });
  return { service, logger, metrics, startSession, read };
};

const startOutcomes = (metrics: ReturnType<typeof fakeMetrics>) =>
  metrics.incrementCounter.mock.calls
    .filter(([name]) => name === "voice_session_start_total")
    .map(([, options]) => (options as { labels: Record<string, string> }).labels);

describe("voice session start", () => {
  it("opens a vendor session on the agent's bound vendor agent with the workspace's own key, and mints the session key", async () => {
    const { service, startSession, read, metrics } = serviceWith({ defaultLocale: "it" });

    const result = await service.start({ workspaceId, agentId, locale: "de-CH" });

    expect(result).toEqual({ kind: "started", vendor: "elevenlabs", signedUrl, sessionKey, locale: "de-CH", expiresAt });
    expect(read).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs" });
    expect(startSession).toHaveBeenCalledWith({ vendorAgentId: "agent_42", credential: { apiKey } });
    expect(startOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "started" }]);
  });

  it("speaks the agent's default language when the page names none, and English when the agent names none either", async () => {
    expect(await serviceWith({ defaultLocale: "it" }).service.start({ workspaceId, agentId }))
      .toMatchObject({ kind: "started", locale: "it" });
    expect(await serviceWith({ defaultLocale: null }).service.start({ workspaceId, agentId }))
      .toMatchObject({ kind: "started", locale: "en" });
  });

  it.each([
    ["the agent no longer exists", { voice: null }, "agent_not_found", "none"],
    ["voice is off for the agent", { voice: { ...boundVoice, enabled: false } }, "voice_off", "none"],
    ["the agent is bound to no vendor agent", { voice: { ...boundVoice, runtime: null } }, "no_runtime", "none"],
  ] as const)("starts nothing when %s", async (_case, overrides, outcome, vendor) => {
    const { service, startSession, read, metrics } = serviceWith(overrides);

    expect(await service.start({ workspaceId, agentId })).toEqual({ kind: "unavailable" });
    expect(read).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(startOutcomes(metrics)).toEqual([{ vendor, outcome }]);
  });

  it("asks the vendor nothing when the workspace holds no key for it", async () => {
    const { service, startSession, metrics } = serviceWith({ credential: null });

    expect(await service.start({ workspaceId, agentId })).toEqual({ kind: "credential_missing", vendor: "elevenlabs" });
    expect(startSession).not.toHaveBeenCalled();
    expect(startOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "credential_missing" }]);
  });

  it("reports a stored key it cannot read, and warns without the key", async () => {
    const { service, startSession, logger, metrics } = serviceWith({ credential: new Error("could not be decrypted") });

    expect(await service.start({ workspaceId, agentId })).toEqual({ kind: "credential_unreadable", vendor: "elevenlabs" });
    expect(startSession).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", errorClass: "Error" },
      "Voice session start could not read the vendor credential",
    );
    expect(startOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "credential_unreadable" }]);
  });

  it("reports a vendor that refused the start, and logs the vendor's status but never the key or the url", async () => {
    const { service, logger, metrics } = serviceWith({
      starter: async () => {
        throw new VoiceVendorRequestError("rejected", 401);
      },
    });

    expect(await service.start({ workspaceId, agentId })).toEqual({ kind: "vendor_failed", vendor: "elevenlabs" });
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", errorClass: "VoiceVendorRequestError", reason: "rejected", vendorStatus: 401 },
      "Voice vendor refused the session start",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
    expect(startOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "vendor_failed" }]);
  });

  it("treats any other failure of the vendor call as the vendor failing", async () => {
    const { service, logger } = serviceWith({
      starter: async () => {
        throw new TypeError("fetch failed");
      },
    });

    expect(await service.start({ workspaceId, agentId })).toEqual({ kind: "vendor_failed", vendor: "elevenlabs" });
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", errorClass: "TypeError" },
      "Voice vendor refused the session start",
    );
  });
});
