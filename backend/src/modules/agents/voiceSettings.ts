import { z } from "zod";

import { isLocaleTag } from "../../shared/domain/locale.js";
import { VOICE_VENDORS } from "../../shared/domain/voiceVendor.js";

const MAX_LOCALES = 10;
const MAX_LINES_PER_STYLE = 5;
const MAX_LINE_LENGTH = 200;
const MAX_VENDOR_AGENT_ID_LENGTH = 128;

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
 * The vendor agent that speaks for this agent: the one a Radioso-started session opens. The id is
 * the vendor's own, opaque to Radioso; it travels in a vendor URL, so it is held to identifier
 * characters. Strict: a key the binding does not name, such as a vendor API key, is refused rather
 * than dropped, so a secret sent here never reads as saved.
 */
const voiceRuntimeSchema = z.object({
  vendor: z.enum(VOICE_VENDORS),
  agentId: z.string().trim().min(1).max(MAX_VENDOR_AGENT_ID_LENGTH).regex(/^[A-Za-z0-9_-]+$/, {
    message: "Must be the vendor's agent id: letters, digits, underscores and hyphens",
  }),
}).strict();

/**
 * How an agent sounds on the voice channel, authored by the operator and read by the voice
 * channel's turn policy and session start, as the agent serves it. The lines and `enabled` are
 * required, so an update that carries the block carries all of them; an update that leaves the
 * block out leaves the stored one alone.
 */
export const agentVoiceSettingsSchema = z.object({
  enabled: z.boolean(),
  bridgeLines: perLocale(bridgeLinesSchema),
  /** Spoken in place of the reply when the turn limit passes with nothing said. */
  fallbackLine: perLocale(voiceLineSchema),
  /** Null until the operator binds a vendor agent; a session start needs one. */
  runtime: voiceRuntimeSchema.nullable(),
});

/**
 * What a write accepts: the block as served, except that `runtime` may be left out, by a writer
 * that predates the binding, and the block is then bound to no vendor agent. Strict, like the
 * runtime binding: a key the block does not name (an API key, a misspelt setting) is refused with
 * its path rather than dropped. Optional rather than defaulted, so a parse keeps one shape for
 * input and output (Ray's tool schemas need that); `storedAgentVoiceSettingsSchema` fills it.
 */
export const agentVoiceSettingsInputSchema = agentVoiceSettingsSchema.extend({
  runtime: voiceRuntimeSchema.nullable().optional(),
}).strict();

/**
 * A written or stored block as the agent keeps it: a block without `runtime` is bound to no vendor
 * agent. Tolerant of keys it does not name, so a stored row a later version wrote still reads.
 */
const storedAgentVoiceSettingsSchema = agentVoiceSettingsSchema.extend({
  runtime: voiceRuntimeSchema.nullable().default(null),
});

export type AgentVoiceSettings = z.infer<typeof agentVoiceSettingsSchema>;

export type VoiceBridgeStyle = keyof z.infer<typeof bridgeLinesSchema>;

export const defaultAgentVoiceSettings = (): AgentVoiceSettings => ({ enabled: false, bridgeLines: {}, fallbackLine: {}, runtime: null });

/**
 * Reads a stored block back. A block this version cannot read turns voice off for the agent rather
 * than failing every read of the agent it belongs to.
 */
export const readStoredAgentVoiceSettings = (stored: unknown): AgentVoiceSettings => {
  const parsed = storedAgentVoiceSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : defaultAgentVoiceSettings();
};

/** Validates a written block as a write must be, then fills its defaults as the agent will store it. */
export const parseWrittenAgentVoiceSettings = (written: unknown) => {
  const parsed = agentVoiceSettingsInputSchema.safeParse(written);
  return parsed.success ? storedAgentVoiceSettingsSchema.safeParse(parsed.data) : parsed;
};
