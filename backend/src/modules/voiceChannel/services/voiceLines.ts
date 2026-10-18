import type { AgentVoiceSettings, VoiceBridgeStyle } from "../../agents/public.js";
import type { VoiceReportedTurnLanguage, VoiceTurnLanguageSource } from "../domain.js";
import { spokenText } from "./speechText.js";

/** The language a turn falls back to when neither the request nor the agent names one. */
const FALLBACK_LOCALE = "en";

/** The language a turn's lines are spoken in, and where it came from. */
export interface VoiceTurnLanguage {
  tag: string;
  source: VoiceTurnLanguageSource;
}

/** What the turn policy may say for this turn; null where the agent authored nothing for it. */
export interface VoiceTurnLines {
  bridge: { style: VoiceBridgeStyle; text: string | null };
  fallbackLine: string | null;
}

/** The turn's lines, and, when the bridge line is shorter than the runtime speaks on its own, by how much. */
interface ChosenVoiceTurnLines extends VoiceTurnLines {
  /** Present when no line of the style reaches the runtime's minimum, so a shorter one was chosen. */
  shortBridge?: { characterCount: number; minimumCharacterCount: number };
}

interface VoiceTurnLineContext {
  /** The turn's language tag, from `resolveVoiceLanguage`. */
  locale: string;
  /** A routine is mid-flight in the conversation at turn start. */
  routineActive: boolean;
  /** Picks among several authored lines, so consecutive turns need not repeat one. */
  rotation: number;
  /** The shortest line the runtime speaks before the answer arrives; absent: any length. */
  minReleasableChars?: number;
}

/** An authored line as the caller hears it; null when nothing is left to say. */
const spoken = (line: string | undefined): string | null => {
  const text = line === undefined ? "" : spokenText(line).trim();
  return text.length > 0 ? text : null;
};

const characterCount = (text: string): number => Array.from(text).length;

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

/**
 * The language a call speaks in: on a turn, the one the request reports for that turn, else the
 * session's, else the agent's default, else English (a session start has no turn). The first that
 * is present wins; lines then match it by tag structure, so a language without lines of its own
 * gets none.
 */
export const resolveVoiceLanguage = (sources: {
  turn?: VoiceReportedTurnLanguage;
  session?: string;
  agentDefault: string | null;
}): VoiceTurnLanguage => {
  if (sources.turn) {
    return { tag: sources.turn.tag, source: sources.turn.source };
  }
  if (sources.session) {
    return { tag: sources.session, source: "session" };
  }
  return sources.agentDefault ? { tag: sources.agentDefault, source: "agent_default" } : { tag: FALLBACK_LOCALE, source: "fallback" };
};

/**
 * The agent's recording notice for a call, as written: in the call's language, else the agent's
 * default language, else English, else the first notice the agent wrote. A caller who must be told
 * the call is recorded is better told in another language than not at all. Null when the agent wrote
 * none.
 */
export const chooseRecordingNotice = (
  settings: Pick<AgentVoiceSettings, "recordingNotice">,
  call: { locale: string; agentDefault: string | null },
): string | null => {
  const written = Object.entries(settings.recordingNotice ?? {})
    .map(([tag, line]) => [tag, line.trim()] as const)
    .filter(([, line]) => line.length > 0);
  const tags = written.map(([tag]) => tag);
  const preferred = [call.locale, call.agentDefault, FALLBACK_LOCALE].filter((tag): tag is string => Boolean(tag));
  const tag = preferred.map((wanted) => matchLocale(tags, wanted)).find((match) => match !== null) ?? tags[0];
  return written.find(([candidate]) => candidate === tag)?.[1] ?? null;
};

/**
 * The turn's bridge and fallback lines. With a runtime minimum, the bridge rotates over the
 * style's lines that reach it; when none does, it rotates over all of them and reports the shortfall.
 */
export const chooseVoiceTurnLines = (settings: AgentVoiceSettings, turn: VoiceTurnLineContext): ChosenVoiceTurnLines => {
  const style: VoiceBridgeStyle = turn.routineActive ? "acknowledge" : "check";
  const withLines = Object.keys(settings.bridgeLines).filter((tag) => (settings.bridgeLines[tag]?.[style].length ?? 0) > 0);
  const bridgeTag = matchLocale(withLines, turn.locale);
  const lines = (bridgeTag ? settings.bridgeLines[bridgeTag]?.[style] ?? [] : []).map(spoken);
  const minimum = turn.minReleasableChars;
  const releasable = minimum === undefined ? lines : lines.filter((line) => line !== null && characterCount(line) >= minimum);
  const pool = releasable.length > 0 ? releasable : lines;
  const text = pool.length > 0 ? pool[turn.rotation % pool.length] ?? null : null;
  const fallbackTag = matchLocale(Object.keys(settings.fallbackLine), turn.locale);
  return {
    bridge: { style, text },
    fallbackLine: fallbackTag ? spoken(settings.fallbackLine[fallbackTag]) : null,
    ...(minimum !== undefined && text !== null && characterCount(text) < minimum
      ? { shortBridge: { characterCount: characterCount(text), minimumCharacterCount: minimum } }
      : {}),
  };
};
