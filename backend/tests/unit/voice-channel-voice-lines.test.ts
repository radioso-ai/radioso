import { describe, expect, it } from "vitest";

import type { AgentVoiceSettings } from "../../src/modules/agents/public.js";
import { chooseRecordingNotice, chooseVoiceTurnLines, resolveVoiceLanguage } from "../../src/modules/voiceChannel/services/voiceLines.js";

const settings: AgentVoiceSettings = {
  enabled: true,
  bridgeLines: {
    en: { acknowledge: ["Got it."], check: ["Let me check.", "One moment.", "Looking into it."] },
    it: { acknowledge: ["Perfetto."], check: ["Controllo subito."] },
    "pt-BR": { acknowledge: [], check: ["Só um momento."] },
  },
  fallbackLine: { en: "Sorry, could you ask me again?", "it-CH": "Scusi, può ripetere?" },
  runtime: null,
};

const choose = (turn: Partial<Parameters<typeof chooseVoiceTurnLines>[1]> = {}) =>
  chooseVoiceTurnLines(settings, { locale: "en", routineActive: false, rotation: 0, ...turn });

describe("voice turn lines", () => {
  it("checks outside a routine and acknowledges inside one", () => {
    expect(choose().bridge).toEqual({ style: "check", text: "Let me check." });
    expect(choose({ routineActive: true }).bridge).toEqual({ style: "acknowledge", text: "Got it." });
  });

  it("rotates through the authored lines by the turn's rotation", () => {
    expect([0, 1, 2, 3].map((rotation) => choose({ rotation }).bridge.text)).toEqual([
      "Let me check.",
      "One moment.",
      "Looking into it.",
      "Let me check.",
    ]);
  });

  it("matches the full tag first, then the bare language, then any tag of the same language", () => {
    expect(choose({ locale: "pt-br" }).bridge.text).toBe("Só um momento.");
    expect(choose({ locale: "it-IT" }).bridge.text).toBe("Controllo subito.");
    expect(choose({ locale: "pt-PT" }).bridge.text).toBe("Só um momento.");
    expect(choose({ locale: "it-IT" }).fallbackLine).toBe("Scusi, può ripetere?");
  });

  it("speaks no bridge when the locale has no line for the style, and no fallback when it has none", () => {
    expect(choose({ locale: "pt-BR", routineActive: true }).bridge).toEqual({ style: "acknowledge", text: null });
    expect(choose({ locale: "de" })).toEqual({ bridge: { style: "check", text: null }, fallbackLine: null });
    expect(choose({ locale: "pt-BR" }).fallbackLine).toBeNull();
  });

  it("removes assertion markers from authored lines and drops a line that was only markers", () => {
    const marked: AgentVoiceSettings = {
      enabled: true,
      bridgeLines: { en: { acknowledge: ["[1]"], check: ["One moment[?]."] } },
      fallbackLine: { en: "Sorry [[2]], ask me again." },
      runtime: null,
    };

    expect(chooseVoiceTurnLines(marked, { locale: "en", routineActive: false, rotation: 0 })).toEqual({
      bridge: { style: "check", text: "One moment." },
      fallbackLine: "Sorry, ask me again.",
    });
    expect(chooseVoiceTurnLines(marked, { locale: "en", routineActive: true, rotation: 0 }).bridge.text).toBeNull();
  });

  it("prefers the lines the runtime speaks on their own, and still speaks a short one when the style has no other", () => {
    const long = "Let me check that for you, it only takes a moment.";
    const mixed: AgentVoiceSettings = {
      enabled: true,
      bridgeLines: { en: { acknowledge: ["Got it."], check: ["One moment.", long, "Looking into it."] } },
      fallbackLine: {},
      runtime: null,
    };
    const turn = { locale: "en", routineActive: false, minReleasableChars: 45 };

    expect([0, 1, 2].map((rotation) => chooseVoiceTurnLines(mixed, { ...turn, rotation }).bridge.text)).toEqual([long, long, long]);
    expect(chooseVoiceTurnLines(mixed, { ...turn, rotation: 0 })).not.toHaveProperty("shortBridge");
    expect(chooseVoiceTurnLines(mixed, { ...turn, routineActive: true, rotation: 0 })).toMatchObject({
      bridge: { style: "acknowledge", text: "Got it." },
      shortBridge: { characterCount: 7, minimumCharacterCount: 45 },
    });
    // A runtime with no minimum takes every line as authored.
    expect(chooseVoiceTurnLines(mixed, { locale: "en", routineActive: false, rotation: 0 }).bridge.text).toBe("One moment.");
  });

  it("takes the turn's language from the turn's own report, then the session, then the agent default, then English", () => {
    expect(resolveVoiceLanguage({ turn: { tag: "it", source: "vendor_detected" }, session: "en", agentDefault: "de" }))
      .toEqual({ tag: "it", source: "vendor_detected" });
    expect(resolveVoiceLanguage({ turn: { tag: "fr-CA", source: "turn_field" }, agentDefault: null }))
      .toEqual({ tag: "fr-CA", source: "turn_field" });
    expect(resolveVoiceLanguage({ session: "it-IT", agentDefault: "de" })).toEqual({ tag: "it-IT", source: "session" });
    expect(resolveVoiceLanguage({ agentDefault: "de" })).toEqual({ tag: "de", source: "agent_default" });
    expect(resolveVoiceLanguage({ agentDefault: null })).toEqual({ tag: "en", source: "fallback" });
  });

  it("speaks a turn that switched to Italian in Italian on a call that started in English", () => {
    const language = resolveVoiceLanguage({ turn: { tag: "it", source: "vendor_detected" }, session: "en", agentDefault: "en" });

    expect(choose({ locale: language.tag })).toEqual({
      bridge: { style: "check", text: "Controllo subito." },
      fallbackLine: "Scusi, può ripetere?",
    });
  });
});

describe("the recording notice", () => {
  const notices = { recordingNotice: { "it-IT": "Questa chiamata viene registrata.", de: "Dieser Anruf wird aufgezeichnet.", en: "This call is recorded." } };

  it("follows the call's language, by tag then by language", () => {
    expect(chooseRecordingNotice(notices, { locale: "it", agentDefault: null })).toBe("Questa chiamata viene registrata.");
    expect(chooseRecordingNotice(notices, { locale: "de-AT", agentDefault: null })).toBe("Dieser Anruf wird aufgezeichnet.");
  });

  it("falls back to the agent's default language, then English, then the first notice written", () => {
    expect(chooseRecordingNotice(notices, { locale: "fr", agentDefault: "de" })).toBe("Dieser Anruf wird aufgezeichnet.");
    expect(chooseRecordingNotice(notices, { locale: "fr", agentDefault: null })).toBe("This call is recorded.");
    expect(chooseRecordingNotice({ recordingNotice: { "it-IT": "Questa chiamata viene registrata.", de: "Dieser Anruf wird aufgezeichnet." } }, { locale: "fr", agentDefault: "es" }))
      .toBe("Questa chiamata viene registrata.");
  });

  it("is none when the agent wrote none, or only blank ones", () => {
    expect(chooseRecordingNotice({}, { locale: "en", agentDefault: null })).toBeNull();
    expect(chooseRecordingNotice({ recordingNotice: { en: "  " } }, { locale: "en", agentDefault: null })).toBeNull();
  });
});
