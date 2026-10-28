import { describe, expect, it, vi } from "vitest";

import type { AgentVoiceSettings } from "../../src/modules/agents/public.js";
import {
  VoiceVendorRequestError,
  type VoiceGreetingSource,
  type VoiceRuntimeConnection,
  type VoiceSessionLanguageSource,
  type VoiceSessionStarter,
  type VoiceSessionStartRegistry,
  type VoiceVendorCredentialPresence,
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

/** The connection Radioso keeps for the agent when it created the bound vendor agent. */
const maintainedConnection: VoiceRuntimeConnection = {
  workspaceId,
  agentId,
  vendor: "elevenlabs",
  region: "eu",
  vendorAgentId: "agent_42",
  channelCredential: { id: "66666666-6666-4666-8666-666666666666", fingerprint: "radioso_66666666" },
};

const serviceWith = (overrides: {
  voice?: AgentVoiceSettings | null;
  defaultLocale?: string | null;
  credential?: VoiceVendorCredentialReading | Error;
  starter?: VoiceSessionStarter["startSession"];
  register?: VoiceSessionStartRegistry["register"];
  stored?: VoiceVendorCredentialPresence | Error;
  /** The agent's runtime connection; none unless a case names one. */
  connection?: VoiceRuntimeConnection | null | Error;
  greeting?: VoiceGreetingSource["greetingFor"];
  greetingWaitMs?: number;
  /** The vendor's answer for the session's language; a locale it speaks no language of unless a case names another. */
  language?: VoiceSessionLanguageSource["languageFor"];
  languageWaitMs?: number;
} = {}) => {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const startSession = vi.fn<VoiceSessionStarter["startSession"]>(overrides.starter ?? (async () => ({ signedUrl, expiresAt })));
  const register = vi.fn<VoiceSessionStartRegistry["register"]>(overrides.register ?? (async () => undefined));
  const read = vi.fn(async (): Promise<VoiceVendorCredentialReading> => {
    const credential = overrides.credential ?? { kind: "present", credential: { apiKey } };
    if (credential instanceof Error) throw credential;
    return credential;
  });
  const presence = vi.fn(async (): Promise<VoiceVendorCredentialPresence> => {
    const stored = overrides.stored ?? "stored";
    if (stored instanceof Error) throw stored;
    return stored;
  });
  const findConnection = vi.fn(async (): Promise<VoiceRuntimeConnection | null> => {
    const connection = overrides.connection ?? null;
    if (connection instanceof Error) throw connection;
    return connection;
  });
  const greetingFor = vi.fn<VoiceGreetingSource["greetingFor"]>(overrides.greeting ?? (async () => null));
  const languageFor = vi.fn<VoiceSessionLanguageSource["languageFor"]>(overrides.language ?? (async () => ({ outcome: "unsupported" })));
  const voice = overrides.voice === undefined ? boundVoice : overrides.voice;
  const service = new VoiceSessionStartService({
    agents: {
      findVoiceProfile: async () => (voice ? { voice, defaultLocale: overrides.defaultLocale ?? null } : null),
    },
    credentials: { read, presence },
    starters: { elevenlabs: { startSession } },
    starts: { register },
    connections: { find: findConnection },
    greetings: { greetingFor },
    ...(overrides.greetingWaitMs === undefined ? {} : { greetingWaitMs: overrides.greetingWaitMs }),
    sessionLanguages: { elevenlabs: { languageFor } },
    ...(overrides.languageWaitMs === undefined ? {} : { languageWaitMs: overrides.languageWaitMs }),
    newSessionKey: () => sessionKey,
    now: () => now,
    metrics,
    logger,
  });
  return { service, logger, metrics, startSession, read, presence, register, findConnection, greetingFor, languageFor };
};

const greetingOutcomes = (metrics: { incrementCounter: ReturnType<typeof vi.fn> }) =>
  metrics.incrementCounter.mock.calls
    .filter(([name]) => name === "voice_session_greeting_total")
    .map(([, options]) => (options as { labels: Record<string, string> }).labels);

const languageOutcomes = (metrics: { incrementCounter: ReturnType<typeof vi.fn> }) =>
  metrics.incrementCounter.mock.calls
    .filter(([name]) => name === "voice_session_language_total")
    .map(([, options]) => (options as { labels: Record<string, string> }).labels);

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
      vendorAgent: { agentId: "agent_42", region: "eu" },
    });
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(startSession.mock.invocationCallOrder[0]);
  });

  it("hands the page the agent's recording notice in the session's language, and none when the agent wrote none", async () => {
    const voice: AgentVoiceSettings = { ...boundVoice, recordingNotice: { en: "This call is recorded.", it: "Questa chiamata viene registrata." } };

    expect(await serviceWith({ voice }).service.start({ workspaceId, agentId, visitor, locale: "it-CH" }))
      .toMatchObject({ kind: "started", recordingNotice: "Questa chiamata viene registrata." });
    // No German notice: English, the fallback language, rather than none.
    expect(await serviceWith({ voice }).service.start({ workspaceId, agentId, visitor, locale: "de" }))
      .toMatchObject({ recordingNotice: "This call is recorded." });
    expect(await serviceWith({}).service.start({ workspaceId, agentId, visitor, locale: "en" }))
      .not.toHaveProperty("recordingNotice");
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

describe("voice session start: the call's first message", () => {
  const noticed: AgentVoiceSettings = { ...boundVoice, recordingNotice: { en: "This call is recorded.", it: "Questa chiamata viene registrata." } };
  const greeting = "Ciao! Sono **Marta**, la tua guida. [Prenota](https://museo.example/prenota) una visita [1].";

  it("opens a call on a vendor agent Radioso maintains with the agent's greeting in the session's language, as words to say", async () => {
    const { service, greetingFor, findConnection, metrics, logger } = serviceWith({ connection: maintainedConnection, greeting: async () => greeting });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "it-CH" });

    expect(result).toMatchObject({ kind: "started", firstMessage: "Ciao! Sono Marta, la tua guida. Prenota una visita." });
    expect(findConnection).toHaveBeenCalledWith({ workspaceId, agentId });
    expect(greetingFor).toHaveBeenCalledWith({ workspaceId, agentId, locale: "it-CH" });
    expect(greetingOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "spoken" }]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, agentId, vendor: "elevenlabs", outcome: "spoken", recordingNotice: false }),
      "Voice session greeting prepared",
    );
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain("Marta");
  });

  it("asks for the agent's default language's greeting when the page names no language", async () => {
    const { service, greetingFor } = serviceWith({ connection: maintainedConnection, greeting: async () => "Hello!" });

    await service.start({ workspaceId, agentId, visitor });

    expect(greetingFor).toHaveBeenCalledWith({ workspaceId, agentId, locale: null });
  });

  it("says the recording notice for the session's language before the greeting", async () => {
    const { service } = serviceWith({ voice: noticed, connection: maintainedConnection, greeting: async () => greeting });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "it" });

    expect(result).toMatchObject({
      recordingNotice: "Questa chiamata viene registrata.",
      firstMessage: "Questa chiamata viene registrata.\n\nCiao! Sono Marta, la tua guida. Prenota una visita.",
    });
  });

  it("says the recording notice alone when the agent has no greeting for the call", async () => {
    const { service, metrics } = serviceWith({ voice: noticed, connection: maintainedConnection, greeting: async () => null });

    expect(await service.start({ workspaceId, agentId, visitor, locale: "en" })).toMatchObject({ firstMessage: "This call is recorded." });
    expect(greetingOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "none" }]);
  });

  it("carries no first message when there is nothing to say", async () => {
    const { service, metrics } = serviceWith({ connection: maintainedConnection, greeting: async () => " **  ** " });

    const result = await service.start({ workspaceId, agentId, visitor });

    expect(result).toMatchObject({ kind: "started" });
    expect(result).not.toHaveProperty("firstMessage");
    expect(greetingOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "none" }]);
  });

  it.each([
    ["Radioso keeps no connection for the agent", null],
    ["the bound vendor agent is another than the one Radioso created", { ...maintainedConnection, vendorAgentId: "agent_7" }],
  ])("carries no first message, and asks for no greeting, when %s: the vendor closes a session that sets one its agent does not allow", async (_case, connection) => {
    const { service, greetingFor, metrics } = serviceWith({ voice: noticed, connection, greeting: async () => greeting });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "en" });

    expect(result).toMatchObject({ kind: "started", recordingNotice: "This call is recorded." });
    expect(result).not.toHaveProperty("firstMessage");
    expect(greetingFor).not.toHaveBeenCalled();
    expect(greetingOutcomes(metrics)).toEqual([]);
  });

  it("starts the call without the greeting when it is not ready in time, and says so", async () => {
    const { service, metrics, logger } = serviceWith({
      voice: noticed,
      connection: maintainedConnection,
      greeting: () => new Promise<string | null>(() => undefined),
      greetingWaitMs: 10,
    });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "en" });

    expect(result).toMatchObject({ kind: "started", firstMessage: "This call is recorded." });
    expect(greetingOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "timed_out" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, agentId, vendor: "elevenlabs", outcome: "timed_out", waitMs: 10 }),
      "Voice session greeting was not ready in time; the call starts without it",
    );
  });

  it("starts the call without the greeting when it cannot be read, and says so", async () => {
    const { service, metrics, logger } = serviceWith({
      connection: maintainedConnection,
      greeting: async () => {
        throw new Error("model unavailable");
      },
    });

    const result = await service.start({ workspaceId, agentId, visitor });

    expect(result).toMatchObject({ kind: "started" });
    expect(result).not.toHaveProperty("firstMessage");
    expect(greetingOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "failed" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", outcome: "failed", step: "greeting", errorClass: "Error" },
      "Voice session greeting could not be read; the call starts without it",
    );
  });

  it("starts the call with no first message at all when the connection cannot be read", async () => {
    const { service, greetingFor, metrics, logger } = serviceWith({ voice: noticed, connection: new Error("connection terminated") });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "en" });

    expect(result).toMatchObject({ kind: "started", recordingNotice: "This call is recorded." });
    expect(result).not.toHaveProperty("firstMessage");
    expect(greetingFor).not.toHaveBeenCalled();
    expect(greetingOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "failed" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", outcome: "failed", step: "connection", errorClass: "Error" },
      "Voice session greeting could not be read; the call starts without it",
    );
  });

  it("reads the greeting while the vendor opens the session", async () => {
    let openSession!: () => void;
    const vendorOpening = new Promise<void>((resolve) => {
      openSession = resolve;
    });
    const { service, greetingFor } = serviceWith({
      connection: maintainedConnection,
      greeting: async () => "Hello!",
      starter: async () => {
        await vendorOpening;
        return { signedUrl, expiresAt };
      },
    });

    const started = service.start({ workspaceId, agentId, visitor });
    await vi.waitFor(() => expect(greetingFor).toHaveBeenCalled());
    openSession();

    expect(await started).toMatchObject({ kind: "started", firstMessage: "Hello!" });
  });

  it("asks for no greeting for a start that fails", async () => {
    const { service, findConnection, greetingFor } = serviceWith({ connection: maintainedConnection, credential: { kind: "missing" } });

    expect(await service.start({ workspaceId, agentId, visitor })).toEqual({ kind: "failed" });
    expect(findConnection).not.toHaveBeenCalled();
    expect(greetingFor).not.toHaveBeenCalled();
  });
});

describe("voice session start: the call's language", () => {
  it("starts a call on a vendor agent Radioso maintains in the session's language, as the vendor names it, when the agent lets a session set it", async () => {
    const { service, languageFor, metrics, logger } = serviceWith({
      connection: maintainedConnection,
      language: async () => ({ outcome: "set", language: "it" }),
    });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "it-CH" });

    expect(result).toMatchObject({ kind: "started", locale: "it-CH", vendorLanguage: "it" });
    expect(languageFor).toHaveBeenCalledWith({ region: "eu", credential: { apiKey }, vendorAgentId: "agent_42", locale: "it-CH" });
    expect(languageOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "set" }]);
    expect(logger.info).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", outcome: "set", language: "it" },
      "Voice session language prepared",
    );
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain(apiKey);
  });

  it("asks for the language the call starts in: the agent's default when the page names none", async () => {
    const { service, languageFor } = serviceWith({ connection: maintainedConnection, defaultLocale: "pt-BR" });

    await service.start({ workspaceId, agentId, visitor });

    expect(languageFor).toHaveBeenCalledWith(expect.objectContaining({ locale: "pt-BR" }));
  });

  it("sets no language for a locale the vendor speaks no language of, and the call starts in the agent's own", async () => {
    const { service, metrics, logger } = serviceWith({ connection: maintainedConnection, language: async () => ({ outcome: "unsupported" }) });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "km" });

    expect(result).toMatchObject({ kind: "started", locale: "km" });
    expect(result).not.toHaveProperty("vendorLanguage");
    expect(languageOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "unsupported" }]);
    expect(logger.info).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", outcome: "unsupported" },
      "Voice session language prepared",
    );
  });

  it("sets no language on a vendor agent that does not let a session set it, which the vendor would close, and says so", async () => {
    const { service, metrics, logger } = serviceWith({
      connection: maintainedConnection,
      greeting: async () => "Ciao!",
      language: async () => ({ outcome: "not_allowed" }),
    });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "it" });

    expect(result).toMatchObject({ kind: "started", firstMessage: "Ciao!" });
    expect(result).not.toHaveProperty("vendorLanguage");
    expect(languageOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "not_allowed" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", outcome: "not_allowed" },
      "Voice session language is not allowed on the vendor agent; the call starts in its default language until Reconnect sets it up",
    );
  });

  it.each([
    ["Radioso keeps no connection for the agent", null],
    ["the bound vendor agent is another than the one Radioso created", { ...maintainedConnection, vendorAgentId: "agent_7" }],
  ])("sets no language, and asks the vendor nothing, when %s", async (_case, connection) => {
    const { service, languageFor, metrics } = serviceWith({ connection, language: async () => ({ outcome: "set", language: "it" }) });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "it" });

    expect(result).toMatchObject({ kind: "started" });
    expect(result).not.toHaveProperty("vendorLanguage");
    expect(languageFor).not.toHaveBeenCalled();
    expect(languageOutcomes(metrics)).toEqual([]);
  });

  it("sets no language, and asks the vendor nothing, when the connection cannot be read", async () => {
    const { service, languageFor, metrics } = serviceWith({ connection: new Error("connection terminated"), language: async () => ({ outcome: "set", language: "it" }) });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "it" });

    expect(result).toMatchObject({ kind: "started" });
    expect(result).not.toHaveProperty("vendorLanguage");
    expect(languageFor).not.toHaveBeenCalled();
    expect(languageOutcomes(metrics)).toEqual([]);
  });

  it("starts the call without a language when the vendor cannot say, and logs why with no key", async () => {
    const { service, metrics, logger } = serviceWith({
      connection: maintainedConnection,
      language: async () => {
        throw new VoiceVendorRequestError("unreachable", 503);
      },
    });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "it" });

    expect(result).toMatchObject({ kind: "started" });
    expect(result).not.toHaveProperty("vendorLanguage");
    expect(languageOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "failed" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", outcome: "failed", errorClass: "VoiceVendorRequestError", reason: "unreachable", vendorStatus: 503 },
      "Voice session language could not be read; the call starts in the vendor agent's default language",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
  });

  it("starts the call without a language when the vendor is slow to say", async () => {
    const { service, metrics, logger } = serviceWith({
      connection: maintainedConnection,
      language: () => new Promise(() => undefined),
      languageWaitMs: 10,
    });

    const result = await service.start({ workspaceId, agentId, visitor, locale: "it" });

    expect(result).toMatchObject({ kind: "started" });
    expect(result).not.toHaveProperty("vendorLanguage");
    expect(languageOutcomes(metrics)).toEqual([{ vendor: "elevenlabs", outcome: "timed_out" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, agentId, vendor: "elevenlabs", outcome: "timed_out", waitMs: 10 },
      "Voice session language was not ready in time; the call starts in the vendor agent's default language",
    );
  });

  it("reads the language while the vendor opens the session, beside the greeting", async () => {
    let openSession!: () => void;
    const vendorOpening = new Promise<void>((resolve) => {
      openSession = resolve;
    });
    const { service, languageFor, greetingFor } = serviceWith({
      connection: maintainedConnection,
      greeting: async () => "Ciao!",
      language: async () => ({ outcome: "set", language: "it" }),
      starter: async () => {
        await vendorOpening;
        return { signedUrl, expiresAt };
      },
    });

    const started = service.start({ workspaceId, agentId, visitor, locale: "it" });
    await vi.waitFor(() => {
      expect(languageFor).toHaveBeenCalled();
      expect(greetingFor).toHaveBeenCalled();
    });
    openSession();

    expect(await started).toMatchObject({ kind: "started", firstMessage: "Ciao!", vendorLanguage: "it" });
  });

  it("reads the agent's connection once for the first message and the language", async () => {
    const { service, findConnection } = serviceWith({ connection: maintainedConnection, language: async () => ({ outcome: "set", language: "it" }) });

    await service.start({ workspaceId, agentId, visitor, locale: "it" });

    expect(findConnection).toHaveBeenCalledOnce();
  });

  it("asks for no language for a start the vendor refused", async () => {
    const { service, metrics } = serviceWith({
      connection: maintainedConnection,
      language: async () => ({ outcome: "set", language: "it" }),
      starter: async () => {
        throw new VoiceVendorRequestError("rejected", 401);
      },
    });

    expect(await service.start({ workspaceId, agentId, visitor, locale: "it" })).toEqual({ kind: "failed" });
    expect(languageOutcomes(metrics)).toEqual([]);
  });
});

describe("voice session availability", () => {
  it("is ready when voice is on, a vendor agent is bound and the workspace holds a key it can read", async () => {
    const { service, presence, read } = serviceWith();

    expect(await service.readiness({ workspaceId, voice: boundVoice })).toEqual({ ready: true, missing: null });
    expect(await service.isAvailable({ workspaceId, voice: boundVoice })).toBe(true);
    expect(presence).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["voice is off", { ...boundVoice, enabled: false }, "voice_channel"],
    ["no vendor agent is bound", { ...boundVoice, runtime: null }, "runtime"],
  ] as const)("names what is missing and reads no key when %s", async (_case, voice, missing) => {
    const { service, presence } = serviceWith();

    expect(await service.readiness({ workspaceId, voice })).toEqual({ ready: false, missing });
    expect(await service.isAvailable({ workspaceId, voice })).toBe(false);
    expect(presence).not.toHaveBeenCalled();
  });

  it("names the vendor key when the workspace holds none for the bound vendor", async () => {
    const { service } = serviceWith({ stored: "missing" });

    expect(await service.readiness({ workspaceId, voice: boundVoice })).toEqual({ ready: false, missing: "vendor_key" });
    expect(await service.isAvailable({ workspaceId, voice: boundVoice })).toBe(false);
  });

  it("names the encryption when a key is stored but the backend has no master key to read it", async () => {
    const { service } = serviceWith({ stored: "unreadable" });

    expect(await service.readiness({ workspaceId, voice: boundVoice })).toEqual({ ready: false, missing: "encryption" });
    expect(await service.isAvailable({ workspaceId, voice: boundVoice })).toBe(false);
  });

  it("offers none, and logs it, when the credential store cannot be read; readiness rejects", async () => {
    const { service, logger, metrics } = serviceWith({ stored: new Error("connection refused") });

    expect(await service.isAvailable({ workspaceId, voice: boundVoice })).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, vendor: "elevenlabs", errorClass: "Error" },
      "Voice availability check failed",
    );
    expect(startOutcomes(metrics)).toEqual([]);
    await expect(service.readiness({ workspaceId, voice: boundVoice })).rejects.toThrow("connection refused");
  });
});
