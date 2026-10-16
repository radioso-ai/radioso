import { describe, expect, it } from "vitest";

import {
  agentInputFieldSchemas,
  agentVoiceSettingsSchema,
  defaultAgentVoiceSettings,
  expectedAgentFieldValue,
  readStoredAgentVoiceSettings,
} from "../../src/modules/agents/public.js";

const authored = {
  enabled: true,
  bridgeLines: {
    en: { acknowledge: ["Got it."], check: ["Let me check that for you.", "One moment."] },
    "it-IT": { acknowledge: ["Perfetto."], check: ["Controllo subito."] },
  },
  fallbackLine: {
    en: "Sorry, that is taking longer than it should. Could you ask me again?",
    "it-IT": "Scusa, ci sto mettendo troppo. Puoi ripetere la domanda?",
  },
  runtime: { vendor: "elevenlabs", agentId: "agent_01jxk2v9qbe8n7r6t5w4" },
};

const lines = (count: number): string[] => Array.from({ length: count }, (_, index) => `Line ${index + 1}.`);

describe("agent voice settings", () => {
  it("accepts authored bridge lines and fallback lines keyed by language tag", () => {
    expect(agentVoiceSettingsSchema.parse(authored)).toEqual(authored);
  });

  it("starts with voice off and nothing authored", () => {
    expect(defaultAgentVoiceSettings()).toEqual({ enabled: false, bridgeLines: {}, fallbackLine: {}, runtime: null });
  });

  it("rejects more than five lines for one style", () => {
    const result = agentVoiceSettingsSchema.safeParse({
      ...authored,
      bridgeLines: { en: { acknowledge: [], check: lines(6) } },
    });

    expect(result.success).toBe(false);
  });

  it.each(["italian", "en_US", "{{locale}}", "e", ""])("rejects %j as a locale key", (key) => {
    expect(agentVoiceSettingsSchema.safeParse({ ...authored, fallbackLine: { [key]: "Sorry." } }).success).toBe(false);
    expect(agentVoiceSettingsSchema.safeParse({
      ...authored,
      bridgeLines: { [key]: { acknowledge: [], check: ["One moment."] } },
    }).success).toBe(false);
  });

  it("rejects a line longer than 200 characters, and a blank one", () => {
    expect(agentVoiceSettingsSchema.safeParse({ ...authored, fallbackLine: { en: "a".repeat(201) } }).success).toBe(false);
    expect(agentVoiceSettingsSchema.safeParse({ ...authored, fallbackLine: { en: "a".repeat(200) } }).success).toBe(true);
    expect(agentVoiceSettingsSchema.safeParse({
      ...authored,
      bridgeLines: { en: { acknowledge: ["   "], check: [] } },
    }).success).toBe(false);
  });

  it("rejects more than ten locales", () => {
    const locales = ["en", "it", "de", "fr", "es", "pt", "nl", "pl", "sv", "da", "fi"];
    const fallbackLine = Object.fromEntries(locales.map((locale) => [locale, "Sorry."]));

    expect(agentVoiceSettingsSchema.safeParse({ ...authored, fallbackLine }).success).toBe(false);
    expect(agentVoiceSettingsSchema.safeParse({
      ...authored,
      fallbackLine: Object.fromEntries(locales.slice(0, 10).map((locale) => [locale, "Sorry."])),
    }).success).toBe(true);
  });

  it("requires the whole block, so a partial one cannot reset the lines it leaves out", () => {
    expect(agentVoiceSettingsSchema.safeParse({ enabled: false }).success).toBe(false);
    expect(agentVoiceSettingsSchema.safeParse({
      ...authored,
      bridgeLines: { en: { check: ["One moment."] } },
    }).success).toBe(false);
  });

  it("binds the agent to one vendor agent, or to none", () => {
    expect(agentVoiceSettingsSchema.parse({ ...authored, runtime: null }).runtime).toBeNull();
    expect(agentVoiceSettingsSchema.parse({ ...authored, runtime: { vendor: "elevenlabs", agentId: "  agent_42  " } }).runtime)
      .toEqual({ vendor: "elevenlabs", agentId: "agent_42" });
  });

  it.each([
    ["an unknown vendor", { vendor: "vapi", agentId: "agent_42" }],
    ["a blank vendor agent id", { vendor: "elevenlabs", agentId: "   " }],
    ["a vendor agent id with a path or query in it", { vendor: "elevenlabs", agentId: "agent_42&branch_id=x" }],
    ["a vendor agent id longer than 128 characters", { vendor: "elevenlabs", agentId: "a".repeat(129) }],
    ["a key the binding does not name, such as an API key", { vendor: "elevenlabs", agentId: "agent_42", apiKey: "xi-secret" }],
  ])("refuses a runtime with %s", (_case, runtime) => {
    expect(agentInputFieldSchemas.voice.safeParse({ ...authored, runtime }).success).toBe(false);
  });

  it("accepts a written block without runtime as bound to no vendor agent, so writers that predate the binding keep working", () => {
    const { runtime: _runtime, ...withoutRuntime } = authored;

    expect(agentInputFieldSchemas.voice.safeParse(withoutRuntime).success).toBe(true);
  });

  it("reads a stored block written before the runtime binding as bound to no vendor agent", () => {
    const { runtime: _runtime, ...storedWithoutRuntime } = authored;

    expect(readStoredAgentVoiceSettings(storedWithoutRuntime)).toEqual({ ...authored, runtime: null });
  });

  it("fences a proposal prepared before the runtime binding on the block as stored, so a missing runtime and null compare equal", () => {
    const { runtime: _runtime, ...preparedBefore } = authored;
    const stored = { ...authored, runtime: null };

    expect(JSON.stringify(expectedAgentFieldValue("voice", preparedBefore))).toBe(JSON.stringify(stored));
    // A bound runtime is a real difference, and other settings compare as they are.
    expect(JSON.stringify(expectedAgentFieldValue("voice", preparedBefore))).not.toBe(JSON.stringify(authored));
    expect(expectedAgentFieldValue("name", "Help Desk")).toBe("Help Desk");
  });

  it("reads a stored block back as authored, and anything unreadable as voice off", () => {
    expect(readStoredAgentVoiceSettings(authored)).toEqual(authored);
    expect(readStoredAgentVoiceSettings(undefined)).toEqual(defaultAgentVoiceSettings());
    expect(readStoredAgentVoiceSettings({ enabled: "yes" })).toEqual(defaultAgentVoiceSettings());
  });
});
