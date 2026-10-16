import { describe, expect, it, vi } from "vitest";

import type { AgentVoiceSettings } from "../../src/modules/agents/public.js";
import {
  VoiceVendorRequestError,
  type VoiceSessionStarter,
  type VoiceSessionStartRegistry,
  type VoiceVendorCredentialReading,
} from "../../src/modules/voiceChannel/domain.js";
import { VoiceSessionStartService } from "../../src/modules/voiceChannel/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const sessionKey = "33333333-3333-4333-8333-333333333333";
const apiKey = "xi-secret-0123456789";
const signedUrl = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_42&conversation_signature=sig";
const expiresAt = new Date("2026-10-16T12:15:00.000Z");
const now = Date.parse("2026-10-16T12:00:00.000Z");
const visitor = { publicSessionId: "44444444-4444-4444-8444-444444444444", visitorKey: "55555555-5555-4555-8555-555555555555" };

const boundVoice: AgentVoiceSettings = {
  enabled: true,
  bridgeLines: {},
  fallbackLine: {},
  runtime: { vendor: "elevenlabs", agentId: "agent_42", region: "eu" },
};

const serviceWith = (overrides: {
  voice?: AgentVoiceSettings | null;
  defaultLocale?: string | null;
  credential?: VoiceVendorCredentialReading | Error;
  starter?: VoiceSessionStarter["startSession"];
  register?: VoiceSessionStartRegistry["register"];
} = {}) => {
  const logger = { warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const startSession = vi.fn<VoiceSessionStarter["startSession"]>(overrides.starter ?? (async () => ({ signedUrl, expiresAt })));
  const register = vi.fn<VoiceSessionStartRegistry["register"]>(overrides.register ?? (async () => undefined));
  const read = vi.fn(async (): Promise<VoiceVendorCredentialReading> => {
    const credential = overrides.credential ?? { kind: "present", credential: { apiKey } };
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
    starts: { register },
    newSessionKey: () => sessionKey,
    now: () => now,
    metrics,
    logger,
  });
  return { service, logger, metrics, startSession, read, register };
};

const startOutcomes = (metrics: { incrementCounter: ReturnType<typeof vi.fn> }) =>
  metrics.incrementCounter.mock.calls
    .filter(([name]) => name === "voice_session_start_total")
    .map(([, options]) => (options as { labels: Record<string, string> }).labels);

describe("voice session start", () => {
  it("opens a vendor session on the agent's bound vendor agent with the workspace's own key, and mints the session key", async () => {
    const { service, startSession, read, metrics } = serviceWith({ defaultLocale: "it" });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "de-CH" });

    expect(result).toEqual({ kind: "started", vendor: "elevenlabs", signedUrl, sessionKey, locale: "de-CH", expiresAt });
    expect(read).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs" });
    expect(startSession).toHaveBeenCalledWith({ vendorAgentId: "agent_42", region: "eu", credential: { apiKey } });
    expect(startOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "started" }]);
  });

  it("records the minted key with the visitor who asked for it before asking the vendor, for well past the URL's validity", async () => {
    const { service, register, startSession } = serviceWith();

    await service.start({ workspaceId, agentId, visitor });

    expect(register).toHaveBeenCalledWith({
      session: { workspaceId, agentId, vendor: "elevenlabs", sessionKey },
      visitor,
      expiresAt: new Date(now + 60 * 60_000),
    });
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(startSession.mock.invocationCallOrder[0]);
  });

  it("speaks the agent's default language when the page names none, and English when the agent names none either", async () => {
    expect(await serviceWith({ defaultLocale: "it" }).service.start({ workspaceId, agentId, visitor }))
      .toMatchObject({ kind: "started", locale: "it" });
    expect(await serviceWith({ defaultLocale: null }).service.start({ workspaceId, agentId, visitor }))
      .toMatchObject({ kind: "started", locale: "en" });
  });

  it.each([
    ["the agent no longer exists", { voice: null }, "agent_not_found", "none"],
    ["voice is off for the agent", { voice: { ...boundVoice, enabled: false } }, "voice_off", "none"],
    ["the agent is bound to no vendor agent", { voice: { ...boundVoice, runtime: null } }, "no_runtime", "none"],
  ] as const)("starts nothing when %s", async (_case, overrides, outcome, vendor) => {
    const { service, startSession, read, register, metrics } = serviceWith(overrides);

    expect(await service.start({ workspaceId, agentId, visitor })).toEqual({ kind: "unavailable" });
    expect(read).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(startOutcomes(metrics)).toEqual([{ vendor, outcome }]);
  });

  it.each([
    ["the workspace holds no key for the vendor", { kind: "missing" } as const, "credential_missing"],
    ["the stored key cannot be decrypted", { kind: "unreadable" } as const, "credential_unreadable"],
  ])("fails without asking the vendor when %s, and counts why", async (_case, credential, outcome) => {
    const { service, startSession, register, metrics, logger } = serviceWith({ credential });

    expect(await service.start({ workspaceId, agentId, visitor })).toEqual({ kind: "failed" });
    expect(startSession).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(startOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome }]);
    expect(logger.warn).toHaveBeenCalledWith({ workspaceId, agentId, vendor: "elevenlabs", outcome }, "Voice session start failed");
  });

  it("counts a credential store that cannot be read apart from a stored key that cannot be decrypted", async () => {
    const { service, startSession, logger, metrics } = serviceWith({ credential: new Error("connection terminated") });

    expect(await service.start({ workspaceId, agentId, visitor })).toEqual({ kind: "failed" });
    expect(startSession).not.toHaveBeenCalled();
    expect(startOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "credential_read_failed" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", outcome: "credential_read_failed", errorClass: "Error" },
      "Voice session start failed",
    );
  });

  it("asks the vendor nothing when the start cannot be recorded", async () => {
    const { service, startSession, metrics } = serviceWith({
      register: async () => {
        throw new Error("connection terminated");
      },
    });

    expect(await service.start({ workspaceId, agentId, visitor })).toEqual({ kind: "failed" });
    expect(startSession).not.toHaveBeenCalled();
    expect(startOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "registration_failed" }]);
  });

  it("fails a start the vendor refused, and logs the vendor's status but never the key or the url", async () => {
    const { service, logger, metrics } = serviceWith({
      starter: async () => {
        throw new VoiceVendorRequestError("rejected", 401);
      },
    });

    expect(await service.start({ workspaceId, agentId, visitor })).toEqual({ kind: "failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        workspaceId,
        agentId,
        vendor: "elevenlabs",
        outcome: "vendor_failed",
        errorClass: "VoiceVendorRequestError",
        reason: "rejected",
        vendorStatus: 401,
      },
      "Voice session start failed",
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

    expect(await service.start({ workspaceId, agentId, visitor })).toEqual({ kind: "failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", outcome: "vendor_failed", errorClass: "TypeError" },
      "Voice session start failed",
    );
  });
});
