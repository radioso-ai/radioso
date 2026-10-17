import { z } from "zod";

import { isLocaleTag } from "../../shared/domain/locale.js";

export const AGENT_MECHANICS_REPLIES_MAX_LOCALES = 10;
const MAX_LINES_PER_MECHANIC = 5;
const MAX_LINE_LENGTH = 200;

const localeKeySchema = z.string().refine(isLocaleTag, { message: "Must be a language tag such as en or it-IT" });

const mechanicsLineSchema = z.string().trim().min(1).max(MAX_LINE_LENGTH);

const mechanicsLinesSchema = z.object({
  greeting: z.array(mechanicsLineSchema).max(MAX_LINES_PER_MECHANIC),
  thanks: z.array(mechanicsLineSchema).max(MAX_LINES_PER_MECHANIC),
  farewell: z.array(mechanicsLineSchema).max(MAX_LINES_PER_MECHANIC),
  acknowledgement: z.array(mechanicsLineSchema).max(MAX_LINES_PER_MECHANIC),
});

/**
 * What the agent says, word for word, to a turn of pure conversational mechanics: lines per
 * mechanic, keyed by language tag. When the turn planner classifies a turn as one of these
 * mechanics and the agent has a line for it in the turn's language, the quick-reply lane speaks
 * an authored line instead of the planner's own words. Every mechanic is required in a locale
 * entry, so an update that carries the block carries all of it; an update that leaves the block
 * out leaves the stored one alone.
 */
export const agentMechanicsRepliesSchema = z
  .record(localeKeySchema, mechanicsLinesSchema)
  .refine((record) => Object.keys(record).length <= AGENT_MECHANICS_REPLIES_MAX_LOCALES, { message: `At most ${AGENT_MECHANICS_REPLIES_MAX_LOCALES} locales` });

export type AgentMechanicsReplies = z.infer<typeof agentMechanicsRepliesSchema>;

export const defaultAgentMechanicsReplies = (): AgentMechanicsReplies => ({});

/**
 * Reads a stored or carried block back. A block this version cannot read leaves the agent with
 * nothing authored rather than failing every read of the agent it belongs to.
 */
export const readStoredAgentMechanicsReplies = (stored: unknown): AgentMechanicsReplies => {
  const parsed = agentMechanicsRepliesSchema.safeParse(stored);
  return parsed.success ? parsed.data : defaultAgentMechanicsReplies();
};
