import type { AgentVoiceSettings } from "../../../src/modules/agents/public.js";

/**
 * The agent's configured fallback line for every voice eval case. `evalRunnerAdapter.ts`'s
 * `observeVoiceTurn` reads a turn's whole spoken text equalling this line as "the turn limit
 * fired", because the turn policy reports the limit only to its metrics observer, not on the
 * `VoiceTurnEvent` stream the port returns. Both the deterministic runner (this fixture) and the
 * live run (`scripts/evalRunnerSupport.ts`'s `seedVoiceSettings`, which writes the same text onto
 * the seeded agent) use this one constant, so the comparison holds on either side.
 */
export const VOICE_EVAL_FALLBACK_LINE = "Still checking on that — thanks for waiting.";

/** The bridge lines a voice eval case's turn may speak while it searches: one, to check. */
export const VOICE_EVAL_BRIDGE_LINES: AgentVoiceSettings["bridgeLines"][string] = {
  acknowledge: [],
  check: ["One moment, let me look that up."],
};

/** The language the deterministic runner's calls are in, and one the live run always writes the lines in. */
export const VOICE_EVAL_LOCALE = "en";

/**
 * What every voice eval case needs of the agent's `voice` block, in each of `locales`: voice on,
 * the bridge lines and the fallback line. `scripts/evalRunnerSupport.ts`'s `seedVoiceSettings`
 * writes them over the agent's own block, so its runtime binding, recording notice, language
 * switching and other languages' lines stay as the operator set them.
 */
export const voiceEvalVoiceLines = (
  locales: readonly string[],
): Pick<AgentVoiceSettings, "enabled" | "bridgeLines" | "fallbackLine"> => ({
  enabled: true,
  bridgeLines: Object.fromEntries(locales.map((locale) => [locale, VOICE_EVAL_BRIDGE_LINES])),
  fallbackLine: Object.fromEntries(locales.map((locale) => [locale, VOICE_EVAL_FALLBACK_LINE])),
});

/**
 * The voice profile the deterministic runner hands `VoiceTurnService` in place of a live agent
 * read: the voice cases' lines with no bound vendor runtime, since no case starts a session.
 */
export const VOICE_EVAL_AGENT_PROFILE = {
  voice: { ...voiceEvalVoiceLines([VOICE_EVAL_LOCALE]), runtime: null } satisfies AgentVoiceSettings,
  defaultLocale: VOICE_EVAL_LOCALE,
};
