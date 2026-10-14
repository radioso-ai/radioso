import { describe, expect, it } from "vitest";

import {
  agentVoiceSettingsSchema,
  defaultAgentVoiceSettings,
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
};

const lines = (count: number): string[] => Array.from({ length: count }, (_, index) => `Line ${index + 1}.`);

describe("agent voice settings", () => {
  it("accepts authored bridge lines and fallback lines keyed by language tag", () => {
    expect(agentVoiceSettingsSchema.parse(authored)).toEqual(authored);
  });

  it("starts with voice off and nothing authored", () => {
    expect(defaultAgentVoiceSettings()).toEqual({ enabled: false, bridgeLines: {}, fallbackLine: {} });
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

  it("reads a stored block back as authored, and anything unreadable as voice off", () => {
    expect(readStoredAgentVoiceSettings(authored)).toEqual(authored);
    expect(readStoredAgentVoiceSettings(undefined)).toEqual(defaultAgentVoiceSettings());
    expect(readStoredAgentVoiceSettings({ enabled: "yes" })).toEqual(defaultAgentVoiceSettings());
  });
});
