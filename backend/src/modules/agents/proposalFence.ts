import { readStoredAgentMechanicsReplies } from "./mechanicsReplies.js";
import { readStoredAgentVoiceSettings } from "./voiceSettings.js";
import type { AgentRecord } from "./domain.js";

/**
 * How a stored nested block reads back, one reader per block: the agent repository maps a row
 * through these, and the proposal fence reads an expected value through the same reader, so a
 * value captured before the block gained a defaulted key compares with that default. A new
 * defaulted block adds its reader here and nowhere else.
 */
export const storedAgentFieldReaders = {
  voice: readStoredAgentVoiceSettings,
  mechanicsReplies: readStoredAgentMechanicsReplies,
} as const satisfies Partial<Record<keyof AgentRecord, (stored: unknown) => unknown>>;

const readerFor = (key: string): ((stored: unknown) => unknown) | undefined =>
  Object.hasOwn(storedAgentFieldReaders, key) ? storedAgentFieldReaders[key as keyof typeof storedAgentFieldReaders] : undefined;

/** The value a reviewed proposal names by `key`, as the agent holds it. */
const proposalFieldValue = (agent: AgentRecord, key: string): unknown => {
  if (key === "anonymousChatEnabled") return agent.surfaceSettings.anonymousChat.enabled;
  if (key === "websiteEmbedEnabled") return agent.surfaceSettings.websiteEmbed.enabled;
  if (key === "websiteEmbedAllowedOrigins") return agent.surfaceSettings.websiteEmbed.allowedOrigins;
  if (key === "websiteEmbedLauncherLabel") return agent.surfaceSettings.websiteEmbed.launcherLabel;
  if (key === "websiteEmbedLauncherPosition") return agent.surfaceSettings.websiteEmbed.launcherPosition;
  return (agent as unknown as Record<string, unknown>)[key];
};

/**
 * The fence a reviewed proposal applies under: the keys whose stored value no longer matches the
 * value the proposal was prepared against. Both sides compare as stored JSON.
 */
export const changedAgentProposalFields = (
  agent: AgentRecord,
  expectedFields: ReadonlyArray<{ readonly key: string; readonly value: unknown }>,
): string[] =>
  expectedFields
    .filter((field) => {
      const expected = readerFor(field.key)?.(field.value) ?? field.value;
      return JSON.stringify(proposalFieldValue(agent, field.key)) !== JSON.stringify(expected);
    })
    .map((field) => field.key);
