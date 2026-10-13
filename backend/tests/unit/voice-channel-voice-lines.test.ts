import { describe, expect, it } from "vitest";

import type { AgentVoiceSettings } from "../../src/modules/agents/public.js";
import { chooseVoiceTurnLines, resolveVoiceTurnLocale } from "../../src/modules/voiceChannel/services/voiceLines.js";

const settings: AgentVoiceSettings = {
  enabled: true,
  bridgeLines: {
    en: { acknowledge: ["Got it."], check: ["Let me check.", "One moment.", "Looking into it."] },
    it: { acknowledge: ["Perfetto."], check: ["Controllo subito."] },
    "pt-BR": { acknowledge: [], check: ["Só um momento."] },
  },
  fallbackLine: { en: "Sorry, could you ask me again?", "it-CH": "Scusi, può ripetere?" },
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
    };

    expect(chooseVoiceTurnLines(marked, { locale: "en", routineActive: false, rotation: 0 })).toEqual({
      bridge: { style: "check", text: "One moment." },
      fallbackLine: "Sorry, ask me again.",
    });
    expect(chooseVoiceTurnLines(marked, { locale: "en", routineActive: true, rotation: 0 }).bridge.text).toBeNull();
  });

  it("takes the turn's locale from the request, then the agent default, then English", () => {
    expect(resolveVoiceTurnLocale({ requested: "it-IT", agentDefault: "de" })).toBe("it-IT");
    expect(resolveVoiceTurnLocale({ agentDefault: "de" })).toBe("de");
    expect(resolveVoiceTurnLocale({ agentDefault: null })).toBe("en");
  });
});
