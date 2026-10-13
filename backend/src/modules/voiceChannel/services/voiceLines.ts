import type { AgentVoiceSettings, VoiceBridgeStyle } from "../../agents/public.js";

/** The language a turn falls back to when neither the request nor the agent names one. */
const FALLBACK_LOCALE = "en";

/** What the turn policy may say for this turn; null where the agent authored nothing for it. */
export interface VoiceTurnLines {
  bridge: { style: VoiceBridgeStyle; text: string | null };
  fallbackLine: string | null;
}

interface VoiceTurnLineContext {
  /** The turn's language tag, from `resolveVoiceTurnLocale`. */
  locale: string;
  /** A routine is mid-flight in the conversation at turn start. */
  routineActive: boolean;
  /** Picks among several authored lines, so consecutive turns need not repeat one. */
  rotation: number;
}

/** Language tags compare case-insensitively; the primary subtag is the language. */
const languageOf = (tag: string): string => tag.split("-")[0]?.toLowerCase() ?? "";

/** The exact tag, else the bare language, else any tag of the same language. Structure only. */
const matchLocale = (tags: readonly string[], locale: string): string | null => {
  const wanted = locale.toLowerCase();
  const language = languageOf(locale);
  return tags.find((tag) => tag.toLowerCase() === wanted)
    ?? tags.find((tag) => tag.toLowerCase() === language)
    ?? tags.find((tag) => languageOf(tag) === language)
    ?? null;
};

export const resolveVoiceTurnLocale = (sources: { requested?: string; agentDefault: string | null }): string =>
  sources.requested ?? sources.agentDefault ?? FALLBACK_LOCALE;

export const chooseVoiceTurnLines = (settings: AgentVoiceSettings, turn: VoiceTurnLineContext): VoiceTurnLines => {
  const style: VoiceBridgeStyle = turn.routineActive ? "acknowledge" : "check";
  const withLines = Object.keys(settings.bridgeLines).filter((tag) => (settings.bridgeLines[tag]?.[style].length ?? 0) > 0);
  const bridgeTag = matchLocale(withLines, turn.locale);
  const lines = bridgeTag ? settings.bridgeLines[bridgeTag]?.[style] ?? [] : [];
  const fallbackTag = matchLocale(Object.keys(settings.fallbackLine), turn.locale);
  return {
    bridge: { style, text: lines.length > 0 ? lines[turn.rotation % lines.length] ?? null : null },
    fallbackLine: fallbackTag ? settings.fallbackLine[fallbackTag] ?? null : null,
  };
};
