import type { Transaction } from "kysely";

import { agentDraftChange, type AgentInput, type NormalizedAgentInput } from "../../modules/agents/public.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import { withAgentDraftMutation } from "./agentDraftMutation.js";

/** Runs an agent write and projects what it changes into the draft (`agentDraftChange`), in one transaction under the draft lock. */
export const withAgentDraftProjection = <T>(
  db: Db,
  target: { workspaceId: string; agentId: string },
  change: { input: AgentInput; normalized: NormalizedAgentInput },
  write: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> => withAgentDraftMutation(db, target.workspaceId, target.agentId, async (trx, snapshot) => {
  const result = await write(trx);
  const draft = agentDraftChange(change.input, change.normalized, snapshot);
  return draft ? { result, snapshot: draft } : { result, unchanged: true as const };
});
