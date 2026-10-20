import type { AgentVoiceSettings } from "../../../src/modules/agents/public.js";

/**
 * The agent's configured fallback line for every voice eval case. `evalRunnerAdapter.ts`'s
 * `observeVoiceTurn` reads a turn's whole spoken text equalling this line as "the turn limit
 * fired", because the turn policy reports the limit only to its metrics observer, not on the
 * `VoiceTurnEvent` stream the port returns. Both the deterministic runner (this fixture) and the
 * live script (`scripts/runEvals.ts`, which writes the same text onto the seeded agent) use this
 * one constant, so the comparison holds on either side.
 */
export const VOICE_EVAL_FALLBACK_LINE = "Still checking on that — thanks for waiting.";

/** The one bridge line a voice eval case's turn may speak while it searches. */
const VOICE_EVAL_BRIDGE_LINE = "One moment, let me look that up.";

/** The agent's `voice` settings block every voice eval case runs against: on, with no bound vendor runtime (no case starts a session). */
export const VOICE_EVAL_AGENT_VOICE_SETTINGS: AgentVoiceSettings = {
  enabled: true,
  bridgeLines: { en: { acknowledge: [], check: [VOICE_EVAL_BRIDGE_LINE] } },
  fallbackLine: { en: VOICE_EVAL_FALLBACK_LINE },
  runtime: null,
};

/** The voice profile the deterministic runner hands `VoiceTurnService` in place of a live agent read. */
export const VOICE_EVAL_AGENT_PROFILE = {
  voice: VOICE_EVAL_AGENT_VOICE_SETTINGS,
  defaultLocale: "en",
};
