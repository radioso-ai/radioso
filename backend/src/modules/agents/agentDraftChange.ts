import { revisionTakesPhotos } from "../visitorImages/contracts/revisionSwitch.js";
import type { AgentRevisionSnapshot } from "./agentRevision.js";
import type { AgentInput, NormalizedAgentInput } from "./domain.js";

/**
 * What an agent write changes in its draft: the instruction whenever it is written, and the photo
 * switch when it changes whether the draft takes photos, since the agent's setting is the draft's
 * value and publishing freezes it. Null when the draft stays as it is.
 */
export const agentDraftChange = (input: AgentInput, normalized: NormalizedAgentInput, snapshot: AgentRevisionSnapshot): AgentRevisionSnapshot | null => {
  const photos = input.visitorImagesEnabled !== undefined && revisionTakesPhotos(snapshot) !== normalized.visitorImagesEnabled;
  if (input.customInstruction === undefined && !photos) return null;
  return {
    ...snapshot,
    ...(input.customInstruction !== undefined ? { customInstruction: normalized.customInstruction } : {}),
    ...(photos ? { visitorImagesEnabled: normalized.visitorImagesEnabled } : {}),
  };
};

/** Whether an agent write reaches its draft (see `agentDraftChange`). */
export const writesAgentDraft = (input: AgentInput): boolean => input.customInstruction !== undefined || input.visitorImagesEnabled !== undefined;
