import { z } from "zod";

import { isLocaleTag } from "../../shared/domain/locale.js";

const MAX_LOCALES = 10;
const MAX_LINES_PER_STYLE = 5;
const MAX_LINE_LENGTH = 200;

const localeKeySchema = z.string().refine(isLocaleTag, { message: "Must be a language tag such as en or it-IT" });

const voiceLineSchema = z.string().trim().min(1).max(MAX_LINE_LENGTH);

/** One record per locale, keyed by language tag. */
const perLocale = <Value extends z.ZodTypeAny>(value: Value) =>
  z.record(localeKeySchema, value).refine((record) => Object.keys(record).length <= MAX_LOCALES, {
    message: `At most ${MAX_LOCALES} locales`,
  });

const bridgeLinesSchema = z.object({
  /** Said inside a routine, when the caller has just answered a step. */
  acknowledge: z.array(voiceLineSchema).max(MAX_LINES_PER_STYLE),
  /** Said outside a routine, while the agent looks the answer up. */
  check: z.array(voiceLineSchema).max(MAX_LINES_PER_STYLE),
});

/**
 * How an agent sounds on the voice channel, authored by the operator and read by the voice
 * channel's turn policy. Every key is required and none has a default, so an update that carries
 * the block carries all of it; an update that leaves the block out leaves the stored one alone.
 */
export const agentVoiceSettingsSchema = z.object({
  enabled: z.boolean(),
  bridgeLines: perLocale(bridgeLinesSchema),
  /** Spoken in place of the reply when the turn limit passes with nothing said. */
  fallbackLine: perLocale(voiceLineSchema),
});

export type AgentVoiceSettings = z.infer<typeof agentVoiceSettingsSchema>;

export type VoiceBridgeStyle = keyof z.infer<typeof bridgeLinesSchema>;

export const defaultAgentVoiceSettings = (): AgentVoiceSettings => ({ enabled: false, bridgeLines: {}, fallbackLine: {} });

/**
 * Reads a stored block back. A block this version cannot read turns voice off for the agent rather
 * than failing every read of the agent it belongs to.
 */
export const readStoredAgentVoiceSettings = (stored: unknown): AgentVoiceSettings => {
  const parsed = agentVoiceSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : defaultAgentVoiceSettings();
};
