import type { AgentVoiceSettings, VoiceBridgeStyle } from "../../agents/public.js";
import type { VoiceReportedTurnLanguage, VoiceTurnLanguage } from "../domain.js";
import { spokenText } from "./speechText.js";

/** The language a turn falls back to when neither the request nor the agent names one. */
const BUILTIN_DEFAULT: VoiceTurnLanguage = { tag: "en", source: "builtin_default" };

/** What the turn policy may say for this turn; null where the agent authored nothing for it. */
export interface VoiceTurnLines {
  bridge: { style: VoiceBridgeStyle; text: string | null };
  fallbackLine: string | null;
}

/**
 * The turn's lines, the language they were picked in, and, when the bridge line is shorter than
 * the runtime speaks on its own, by how much.
 */
interface ChosenVoiceTurnLines extends VoiceTurnLines {
  language: VoiceTurnLanguage;
  /** Present when no line of the style reaches the runtime's minimum, so a shorter one was chosen. */
  shortBridge?: { characterCount: number; minimumCharacterCount: number };
}

/** Where a call's language can come from, most specific first. */
interface VoiceLanguageSources {
  /** The language the request reports for its turn; a session start has none. */
  turn?: VoiceReportedTurnLanguage;
  /** The session's language tag, as the request carries it. */
  session?: string;
  agentDefault: string | null;
}

interface VoiceTurnLineContext {
  languages: VoiceLanguageSources;
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
 * Every language the call may be spoken to in, most specific first: the one the request reports
 * for the turn, the session's, the agent's default, English. A session start has no turn.
 */
const languagesInOrder = (sources: VoiceLanguageSources): VoiceTurnLanguage[] => [
  ...(sources.turn ? [{ tag: sources.turn.tag, source: sources.turn.source }] : []),
  ...(sources.session ? [{ tag: sources.session, source: "session" as const }] : []),
  ...(sources.agentDefault ? [{ tag: sources.agentDefault, source: "agent_default" as const }] : []),
  BUILTIN_DEFAULT,
];

/** The language a call speaks in: the first `languagesInOrder` names. */
export const resolveVoiceLanguage = (sources: VoiceLanguageSources): VoiceTurnLanguage => languagesInOrder(sources)[0] ?? BUILTIN_DEFAULT;

const tagsInOrder = (sources: VoiceLanguageSources): string[] => languagesInOrder(sources).map((language) => language.tag);

/** The first preferred language the tags serve, as the tag that serves it. */
const firstServed = (tags: readonly string[], preferred: readonly string[]): string | null =>
  preferred.map((wanted) => matchLocale(tags, wanted)).find((match) => match !== null) ?? null;

/**
 * The agent's recording notice for a call, as written: in the session's language, else the agent's
 * default language, else English, else the first notice the agent wrote. A caller who must be told
 * the call is recorded is better told in another language than not at all. Null when the agent wrote
 * none.
 */
export const chooseRecordingNotice = (
  settings: Pick<AgentVoiceSettings, "recordingNotice">,
  call: Omit<VoiceLanguageSources, "turn">,
): string | null => {
  const written = Object.entries(settings.recordingNotice ?? {})
    .map(([tag, line]) => [tag, line.trim()] as const)
    .filter(([, line]) => line.length > 0);
  const tags = written.map(([tag]) => tag);
  const tag = firstServed(tags, tagsInOrder(call)) ?? tags[0];
  return written.find(([candidate]) => candidate === tag)?.[1] ?? null;
};

/**
 * The turn's bridge and fallback lines. The bridge is in the turn's language or not at all: a
 * line in another language would greet the caller before the answer does. On a turn that reports
 * its own language, the fallback line is the next language's that has one, so a caller who
 * switched to a language without lines hears the call's other language rather than waiting past
 * the limit; without a reported language it is the session's language's or none, as authored.
 * With a runtime minimum, the bridge rotates over the style's lines that reach it; when none does,
 * it rotates over all of them and reports the shortfall.
 */
export const chooseVoiceTurnLines = (settings: AgentVoiceSettings, turn: VoiceTurnLineContext): ChosenVoiceTurnLines => {
  const language = resolveVoiceLanguage(turn.languages);
  const style: VoiceBridgeStyle = turn.routineActive ? "acknowledge" : "check";
  const withLines = Object.keys(settings.bridgeLines).filter((tag) => (settings.bridgeLines[tag]?.[style].length ?? 0) > 0);
  const bridgeTag = matchLocale(withLines, language.tag);
  const lines = (bridgeTag ? settings.bridgeLines[bridgeTag]?.[style] ?? [] : []).map(spoken);
  const minimum = turn.minReleasableChars;
  const releasable = minimum === undefined ? lines : lines.filter((line) => line !== null && characterCount(line) >= minimum);
  const pool = releasable.length > 0 ? releasable : lines;
  const text = pool.length > 0 ? pool[turn.rotation % pool.length] ?? null : null;
  const fallbackLines = Object.entries(settings.fallbackLine).flatMap(([tag, line]) => {
    const said = spoken(line);
    return said === null ? [] : [[tag, said] as const];
  });
  const fallbackTag = firstServed(fallbackLines.map(([tag]) => tag), turn.languages.turn ? tagsInOrder(turn.languages) : [language.tag]);
  return {
    language,
    bridge: { style, text },
    fallbackLine: fallbackLines.find(([tag]) => tag === fallbackTag)?.[1] ?? null,
    ...(minimum !== undefined && text !== null && characterCount(text) < minimum
      ? { shortBridge: { characterCount: characterCount(text), minimumCharacterCount: minimum } }
      : {}),
  };
};
