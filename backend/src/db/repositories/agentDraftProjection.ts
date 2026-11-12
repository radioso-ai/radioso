import type { Transaction } from "kysely";

import type { AgentInput, AgentRevisionSnapshot, NormalizedAgentInput } from "../../modules/agents/public.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import { withAgentDraftMutation } from "./agentDraftMutation.js";

/**
 * What an agent write changes in its draft: the instruction whenever it is written, and the photo
 * switch when it changes, since the agent's setting is the draft's value and publishing freezes it.
 * Null when the draft stays as it is.
 */
const draftChangeOf = (input: AgentInput, normalized: NormalizedAgentInput, snapshot: AgentRevisionSnapshot): AgentRevisionSnapshot | null => {
  const photos = input.visitorImagesEnabled !== undefined && snapshot.visitorImagesEnabled !== normalized.visitorImagesEnabled;
  if (input.customInstruction === undefined && !photos) return null;
  return {
    ...snapshot,
    ...(input.customInstruction !== undefined ? { customInstruction: normalized.customInstruction } : {}),
    ...(photos ? { visitorImagesEnabled: normalized.visitorImagesEnabled } : {}),
  };
};

/** Whether an agent write reaches its draft (see `draftChangeOf`). */
export const writesAgentDraft = (input: AgentInput): boolean => input.customInstruction !== undefined || input.visitorImagesEnabled !== undefined;

/** Runs an agent write and projects what it changes into the draft, in one transaction under the draft lock. */
export const withAgentDraftProjection = <T>(
  db: Db,
  target: { workspaceId: string; agentId: string },
  change: { input: AgentInput; normalized: NormalizedAgentInput },
  write: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> => withAgentDraftMutation(db, target.workspaceId, target.agentId, async (trx, snapshot) => {
  const result = await write(trx);
  const draft = draftChangeOf(change.input, change.normalized, snapshot);
  return draft ? { result, snapshot: draft } : { result, unchanged: true as const };
});
